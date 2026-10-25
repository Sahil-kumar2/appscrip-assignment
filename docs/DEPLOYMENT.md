# Production Deployment Guide

This document outlines the recommended architecture, configuration, security posture, and scaling roadmap for deploying the **Real-Time Device Operations Platform (APS)** to enterprise cloud infrastructure (e.g., AWS, GCP, Azure).

---

## 1. Cloud Architecture Topology

In a production environment, containerized services run as stateless tasks across multiple Availability Zones, backed by a managed PostgreSQL cluster:

```
                            [ Internet / Cellular Gateway ]
                                         │
                                  TLS 1.3 / HTTPS
                                         ▼
                     ┌──────────────────────────────────────┐
                     │   Cloud Load Balancer (ALB / Envoy)  │
                     │   - TLS Termination & WAF            │
                     │   - Health Probes (/healthz, /readyz)│
                     └───────────────────┬──────────────────┘
                                         │
                   ┌─────────────────────┴─────────────────────┐
                   ▼                                           ▼
       ┌───────────────────────┐                   ┌───────────────────────┐
       │   API Replica 1       │                   │   API Replica 2       │
       │   (Fastify REST/SSE)  │                   │   (Fastify REST/SSE)  │
       └───────────┬───────────┘                   └───────────┬───────────┘
                   │                                           │
                   └─────────────────────┬─────────────────────┘
                                         ▼
                     ┌──────────────────────────────────────┐
                     │   PgBouncer / AWS RDS Proxy          │
                     │   (Transaction Connection Pooling)   │
                     └───────────────────┬──────────────────┘
                                         ▼
                     ┌──────────────────────────────────────┐
                     │   Managed PostgreSQL 16 (Primary)    │
                     │   - Multi-AZ Synchronous Standby     │
                     │   - Point-In-Time Recovery (PITR)    │
                     │   - SSD / Provisioned IOPS Storage   │
                     └───────────────────┬──────────────────┘
                                         │ FOR UPDATE SKIP LOCKED
                   ┌─────────────────────┴─────────────────────┐
                   ▼                                           ▼
       ┌───────────────────────┐                   ┌───────────────────────┐
       │   Worker Replica 1    │                   │   Worker Replica 2    │
       │   - Queue Worker      │                   │   - Queue Worker      │
       │   - Outbox Notifier   │                   │   - Outbox Notifier   │
       │   - Absence Leader *  │                   │   - Absence Standby   │
       └───────────┬───────────┘                   └───────────┬───────────┘
                   │                                           │
                   └─────────────────────┬─────────────────────┘
                                         │ Webhooks (HMAC-SHA256, Idempotency-Key)
                                         ▼
                     ┌──────────────────────────────────────┐
                     │   External Operator Webhook Sinks    │
                     │   (PagerDuty, Opsgenie, Custom HTTP) │
                     └──────────────────────────────────────┘
```

_\* Note: Only one worker instance holds the PostgreSQL advisory lock (`424242`) for `AbsenceMonitor` leadership at any given time._

---

## 2. Managed Database Infrastructure

### Recommended Engine & Tier

- **Engine**: PostgreSQL 16 on **AWS RDS / Aurora PostgreSQL** or **GCP Cloud SQL**.
- **Instance Sizing**: Start with at least 4 vCPU, 16 GB RAM (e.g., `db.r6g.xlarge` or `db-custom-4-16384`) with SSD storage and provisioned IOPS (minimum 3,000 IOPS).
- **High Availability**: Multi-AZ deployment with automatic synchronous failover.
- **Backups & PITR**: Continuous WAL archiving to S3/GCS with 30-day Point-In-Time Recovery and daily automated snapshots.

### Autovacuum & Write Tuning for Queue Tables

Queue workloads in PostgreSQL create high row churn (rapid `INSERT`, `UPDATE processing_status`, and `DELETE` or archiving). Tune autovacuum aggressively to prevent table bloat and transaction wraparound:

```ini
# PostgreSQL Configuration (postgresql.conf / Parameter Group)
autovacuum = on
autovacuum_vacuum_scale_factor = 0.05       # Trigger vacuum after 5% row changes (default is 20%)
autovacuum_analyze_scale_factor = 0.02      # Update statistics after 2% row changes
autovacuum_vacuum_cost_limit = 1000         # Allow autovacuum more I/O throughput
autovacuum_max_workers = 5                  # Dedicated vacuum workers

# Memory allocation
shared_buffers = 4GB                        # 25% of total system RAM
work_mem = 32MB                             # Per-query sort/hash memory
maintenance_work_mem = 512MB                # Vacuum and index creation memory
```

### Connection Pooling (PgBouncer / RDS Proxy)

- **API Nodes**: Use **Transaction Pooling** mode via PgBouncer or AWS RDS Proxy. Each request obtains a connection only for the duration of the SQL statement/transaction.
- **Workers & SSE Listeners**: PostgreSQL `LISTEN/NOTIFY` requires a persistent backend connection. The worker queue worker and SSE listeners must bypass transaction pooling or connect via a dedicated **Session Pooling** endpoint.

---

## 3. Stateless API Tier

### Deployment & Scaling

- Deploy API instances as stateless containers (Docker on AWS ECS Fargate, Kubernetes/EKS, or GCP Cloud Run).
- Place API pods behind an Application Load Balancer (ALB) or Nginx ingress controller with round-robin or least-outstanding-requests routing.
- **Liveness Probe**: `GET /healthz` (200 OK confirms HTTP listener is responsive).
- **Readiness Probe**: `GET /readyz` (Verifies DB connection pool healthy, pending queue lag < 300s). ALB removes non-ready pods automatically.
- **Graceful Shutdown**: On `SIGTERM`, Fastify stops accepting new connections, waits up to 10 seconds to finish in-flight requests, and closes the DB pool cleanly.

### Configuration

Configure API instances via environment variables injected from secrets managers:

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://app_user:strong_password@pg-proxy.internal:5432/aps?sslmode=verify-full
OPERATOR_TOKEN=sec-operator-live-prod-token
QUEUE_BACKPRESSURE_THRESHOLD=5000
RATE_LIMIT_MAX_PER_MINUTE=120
LOG_LEVEL=info
```

---

## 4. Scalable Background Worker Fleet

### Multi-Replica Concurrency

- Workers scale horizontally based on queue depth and processing lag.
- **Safe Queue Claiming**: Queue processing uses `SELECT ... FOR UPDATE SKIP LOCKED` inside a short transaction, locking rows with a 30-second lease (`locked_until`). Multiple worker replicas can safely query the same table simultaneously without contention, locking deadlocks, or duplicate processing.
- **Absence Leader Election**: To prevent duplicate absence incidents and unnecessary DB queries, the `AbsenceMonitor` acquires an advisory lock (`pg_try_advisory_lock(424242)`). If the active leader container dies, the advisory lock is automatically released by PostgreSQL, and another worker replica acquires it within 5 seconds.
- **Graceful Shutdown**: On `SIGTERM`, workers complete the currently leased batch, set `isShuttingDown = true` to reject new loop iterations, and cleanly terminate.

---

## 5. Real-Time Streaming (SSE) Fan-Out at Scale

### Current Architecture & Boundary

The current implementation connects API instances to PostgreSQL via `LISTEN change_log` and fans out events in-memory to connected SSE web clients (`/api/stream`).

### Scaling Multi-Replica API Nodes

While `LISTEN/NOTIFY` works cleanly for moderate deployments (up to ~5-10 API replicas and hundreds of SSE clients), each replica consumes a persistent Postgres backend session and PostgreSQL limits notification payloads to 8,000 bytes.

**Production Evolution for Large Scale (> 10 API Replicas / > 1,000 Concurrent SSE Dashboards)**:

1. Replace direct PostgreSQL `LISTEN` in API pods with **Redis Pub/Sub** or **NATS**.
2. A single dedicated worker process reads `change_log` (or consumes PostgreSQL logical replication / Debezium CDC) and publishes change events to the Redis channel `aps:change_log`.
3. All API replicas subscribe to the Redis channel, completely offloading fan-out load from the primary PostgreSQL database.

---

## 6. Table Partitioning & Data Retention

The `events`, `rejected_events`, and `rule_evaluations` tables grow monotonically. In production, unbounded growth degrades B-tree index performance and drives up storage costs.

### Declarative Range Partitioning for `events`

Partition the `events` table by month using PostgreSQL native declarative partitioning:

```sql
-- Convert events table to partitioned table
CREATE TABLE events (
    event_id UUID NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    seq BIGINT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    schema_version INT NOT NULL DEFAULT 1,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_error TEXT,
    PRIMARY KEY (received_at, device_id, event_id)
) PARTITION BY RANGE (received_at);

-- Monthly partition examples:
CREATE TABLE events_2026_10 PARTITION OF events
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE events_2026_11 PARTITION OF events
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
```

Use `pg_partman` or an automated AWS Lambda/cron task to provision future partitions 1 month in advance.

### Retention & Archival Policies

- **Raw Events**: Retain in active PostgreSQL storage for **30 to 90 days**. Run a scheduled ETL job (AWS Glue, dbt, or pg_dump) to export older partitions to Parquet format on Amazon S3 / Google Cloud Storage for long-term historical analytics via Athena / BigQuery.
- **Rule Evaluations**: Retain for **30 days**, then truncate older partitions.
- **Change Log**: The `change_log` table is used only for real-time streaming and short-term reconnections. Automatically purge entries older than 7 days where `seq < (max_seq - 500,000)`:
  ```sql
  DELETE FROM change_log WHERE created_at < NOW() - INTERVAL '7 days';
  ```
- **Rejected Events**: Already capped at 10,000 rows via database trigger.

---

## 7. Security, TLS & Authentication

### Secrets Management

- Never store API keys, operator tokens, or database credentials in source control or plain text environment files.
- Inject secrets at container startup using **AWS Secrets Manager**, **GCP Secret Manager**, or **HashiCorp Vault**.

### Transport Security & Network Boundaries

- Terminate **TLS 1.3** at the load balancer using automated certificates (AWS Certificate Manager / Let's Encrypt).
- Place database and worker instances strictly within **private VPC subnets** with zero public internet egress/ingress.
- Internal traffic between API and database must use SSL/TLS (`sslmode=verify-full`).

### Device Authentication Roadmap (mTLS vs API Keys)

- **Current Model**: Per-device static API keys hashed with SHA-256 in the database. Supports zero-downtime key rotation via `POST /api/devices/:id/rotate-key` and rate-limiting per key.
- **Enterprise mTLS Evolution**:
  - For high-security environments, terminate Mutual TLS (mTLS) at the edge load balancer (e.g., AWS API Gateway or Cloudflare).
  - Devices authenticate using unique X.509 client certificates provisioned onto hardware Secure Elements / TPMs during factory staging.
  - The load balancer verifies client certificates against a Private Certificate Authority (Private CA) and forwards the authenticated `X-Device-Id` in a signed JWT to the Fastify API.

---

## 8. Observability & Alerting Playbook

Scrape the Prometheus `/metrics` endpoint on API and Worker pods every 15 seconds.

### Critical Alert Rules

| Alert Name                 | Metric Condition                                                         | Severity          | Action / Mitigation                                                                     |
| :------------------------- | :----------------------------------------------------------------------- | :---------------- | :-------------------------------------------------------------------------------------- |
| **QueueLagCritical**       | `aps_queue_lag_seconds > 300` for 3m                                     | **P1 - Critical** | Worker fleet cannot keep up. Scale worker replicas or investigate DB lock contention.   |
| **DeadLetterDetected**     | `increase(aps_events_total{status="failed"}[5m]) > 0`                    | **P2 - Major**    | Events permanently failing processing. Inspect `GET /api/dead-letters` and worker logs. |
| **CircuitBreakerTripped**  | `aps_circuit_breaker_open{host=~".+"} == 1` for 2m                       | **P2 - Major**    | Downstream operator webhook is down. Confirm webhook endpoint status.                   |
| **BackpressureActive**     | `aps_queue_depth_pending > 5000` or `rate(aps_ingest_429_total[5m]) > 5` | **P2 - Major**    | Ingestion throttled. Devices receiving 429 Retry-After. Scale workers.                  |
| **DeadNotifications**      | `increase(aps_outbox_total{status="dead"}[5m]) > 0`                      | **P2 - Major**    | Notifications exhausted max attempts. Check destination URL; retry via API.             |
| **DatabasePoolExhaustion** | `pg_stat_activity` active connections > 85% pool limit                   | **P1 - Critical** | Increase PgBouncer pool limits or optimize slow queries.                                |

---

## 9. Scaling Triggers: When to Move to Kafka / MQTT

The PostgreSQL-backed queue and HTTP REST protocol chosen for this platform provide tremendous operational simplicity, ACID transactions, and zero infrastructure overhead for the majority of IoT workloads. However, clear architectural thresholds dictate when to transition components:

### When to Migrate Ingestion Queue to Apache Kafka / Redpanda

| Metric / Requirement               | PostgreSQL Queue (Current)          | Apache Kafka / Redpanda                                                                        |
| :--------------------------------- | :---------------------------------- | :--------------------------------------------------------------------------------------------- |
| **Sustained Ingestion Throughput** | Up to ~3,000 events/second          | > 10,000 to 1,000,000+ events/second                                                           |
| **Queue Depth Capacity**           | Up to 100,000 pending items safely  | Millions of backlog items without IOPS degradation                                             |
| **Consumer Decoupling**            | Workers and API share database IOPS | High-throughput streaming to multiple decoupled consumers (analytics, ML pipelines, data lake) |
| **Operational Complexity**         | Low (Single managed database)       | High (Requires dedicated brokers, schema registries, partition rebalancing, ZooKeeper/KRaft)   |

**Recommendation**: Retain PostgreSQL while sustained ingestion remains under 3,000 events/sec. If sustained fleet volume exceeds 5,000 events/sec, place an HTTP-to-Kafka gateway or AWS Kinesis stream in front of the worker pipeline.

### When to Migrate Device Protocol to MQTT (EMQX / AWS IoT Core)

| Metric / Requirement           | HTTP POST /v1/events (Current)                | MQTT over TLS                                                         |
| :----------------------------- | :-------------------------------------------- | :-------------------------------------------------------------------- |
| **Network Bandwidth**          | ~500–800 bytes HTTP header overhead per batch | Minimal 2-byte header overhead; ideal for cellular/satellite          |
| **Communication Pattern**      | Unidirectional Device-to-Cloud push           | Bidirectional (Cloud-to-Device commands, OTA firmware, remote config) |
| **Connection Model**           | Ephemeral HTTP request/response               | Persistent, keep-alive TCP connection                                 |
| **Firewall / Proxy Traversal** | Trivial (Standard HTTPS port 443)             | May require special proxy configuration or MQTT-over-WebSockets       |

**Recommendation**: Retain HTTP POST for battery-powered sensors using periodic sleep/wake cycles, webhooks, and cellular gateways. Migrate to MQTT if devices require real-time cloud-to-device actuation or sub-second bidirectional command channels.

---

## 10. Explicit Platform Limitations

To maintain architectural honesty, the following constraints and known limitations exist in the current implementation:

1. **Advisory Lock Single-Point of Absence Leadership**: The absence evaluation loop relies on a PostgreSQL session advisory lock. If the leader worker hangs without severing its TCP socket, failover is bounded by the TCP keep-alive timeout (~30s).
2. **PostgreSQL Write Amplification**: Extremely high event volume (> 5,000 events/sec) with frequent updates to `processing_status` will cause write amplification and require frequent autovacuum cycles.
3. **In-Memory Rate Limiting**: The current API rate limiter uses an in-memory sliding window per API instance. Across multiple API replicas, total allowed requests scale by the number of instances unless backed by a shared Redis instance or sticky device routing at the load balancer.
4. **SSE Single-Node LISTEN**: Multiple API replicas currently establish independent PostgreSQL `LISTEN` connections. For fleets exceeding 20 API pods, fan-out must be migrated to Redis Pub/Sub as described in Section 5.
