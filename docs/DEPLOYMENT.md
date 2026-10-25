# Production Deployment & Infrastructure Blueprint

This document details the recommended enterprise deployment architecture, managed database sizing, connection pooling topology, and scaling strategy for the Real-Time Operations Platform on cloud environments (AWS, GCP, or Azure).

---

## 1. Enterprise Cloud Architecture Topology

```
                                [ Industrial Edge Fleet & Gateways ]
                                                 │
                                         TLS 1.3 / HTTPS
                                                 ▼
                             ┌──────────────────────────────────────┐
                             │    Cloud Load Balancer (AWS ALB)     │
                             │    - WAF Rate Limiting               │
                             │    - TLS 1.3 Termination             │
                             │    - Health Checks (/healthz, /readyz)│
                             └───────────────────┬──────────────────┘
                                                 │
                        ┌────────────────────────┴────────────────────────┐
                        ▼                                                 ▼
            ┌───────────────────────┐                         ┌───────────────────────┐
            │   API Pod 1 (Fastify) │                         │   API Pod 2 (Fastify) │
            │   - Edge Ingestion    │                         │   - Edge Ingestion    │
            │   - Operator REST/SSE │                         │   - Operator REST/SSE │
            └───────────┬───────────┘                         └───────────┬───────────┘
                        │                                                 │
                        └────────────────────────┬────────────────────────┘
                                                 │
                                                 ▼
                             ┌──────────────────────────────────────┐
                             │    PgBouncer Connection Pooler       │
                             │    (Transaction Mode Pooling)        │
                             └───────────────────┬──────────────────┘
                                                 │
                                                 ▼
                             ┌──────────────────────────────────────┐
                             │    Managed PostgreSQL 16 Cluster     │
                             │    (AWS RDS / GCP Cloud SQL Multi-AZ)│
                             │    - Synchronous Standby             │
                             │    - Automated Daily Snapshots & PITR│
                             │    - Provisioned IOPS (gp3 / io2)    │
                             └───────────────────┬──────────────────┘
                                                 │
                                                 │ FOR UPDATE SKIP LOCKED
                        ┌────────────────────────┴────────────────────────┐
                        ▼                                                 ▼
            ┌───────────────────────┐                         ┌───────────────────────┐
            │   Worker Pod 1        │                         │   Worker Pod 2        │
            │   - Queue Worker      │                         │   - Queue Worker      │
            │   - Outbox Dispatcher │                         │   - Outbox Dispatcher │
            │   - Absence Leader *  │                         │   - Absence Standby   │
            └───────────┬───────────┘                         └───────────┬───────────┘
                        │                                                 │
                        └────────────────────────┬────────────────────────┘
                                                 │ Webhooks (Idempotency-Key)
                                                 ▼
                             ┌──────────────────────────────────────┐
                             │   External Notification Receivers    │
                             │   (PagerDuty, Opsgenie, Webhooks)    │
                             └──────────────────────────────────────┘
```

_\* Note: Only one worker instance holds the PostgreSQL advisory lock (`424242`) for `AbsenceMonitor` leadership at any given time._

---

## 2. Managed Database Sizing & Engine Tuning

### Sizing Baseline

- **Recommended Instance**: AWS RDS PostgreSQL 16 `db.r6g.xlarge` (4 vCPU, 32 GB RAM) or GCP Cloud SQL `db-custom-4-32768`.
- **Storage**: Minimum 250 GB Provisioned IOPS SSD (`gp3` with 4,000 IOPS and 250 MB/s throughput, or `io2`).

### PostgreSQL Configuration Parameters (`postgresql.conf`)

```ini
# Memory Configuration
shared_buffers = 8GB                  # 25% of total system RAM
work_mem = 32MB                       # Allocations per sorting/hash operation
maintenance_work_mem = 1GB            # Accelerated indexing and VACUUM
effective_cache_size = 24GB           # 75% of total system RAM

# Checkpoints and Write-Ahead Logging (WAL)
wal_buffers = 16MB
max_wal_size = 16GB
min_wal_size = 2GB
checkpoint_completion_target = 0.9    # Smooth out checkpoint I/O spikes
synchronous_commit = off              # Optional: Boosts ingest throughput at slight RPO trade-off

# High-Velocity Queue Autovacuum Optimization
autovacuum = on
autovacuum_max_workers = 5
autovacuum_vacuum_scale_factor = 0.05  # Trigger vacuum when 5% of rows are updated/deleted
autovacuum_analyze_scale_factor = 0.02
autovacuum_vacuum_cost_limit = 2000   # Prevent autovacuum from choking on rapid queue churn
autovacuum_vacuum_cost_delay = 2ms
```

---

## 3. Connection Pooling via PgBouncer

Because containerized API and worker tasks scale horizontally, direct PostgreSQL connections can quickly saturate the database process limit.

### Recommended Configuration (`pgbouncer.ini`)

```ini
[databases]
aps = host=managed-postgres.internal port=5432 dbname=aps

[pgbouncer]
listen_port = 6432
listen_addr = *
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

# Transaction Pooling Mode is required for scalable stateless workloads
pool_mode = transaction
max_client_conn = 2000
default_pool_size = 50
min_pool_size = 10
reserve_pool_size = 10
reserve_pool_timeout = 5
```

> [!IMPORTANT]
> **Advisory Lock & LISTEN Note**: In transaction pooling mode, named session-level locks and `LISTEN` connections must be established over a dedicated direct connection pool or managed with session pooling. The Fastify API's SSE streamer maintains a single persistent `LISTEN` connection per API replica.

---

## 4. Horizontal Auto-Scaling Policies

### Ingestion API Tier (`apps/api`)

- **Metric**: Target CPU utilization $\ge 70\%$ or Ingestion Request Rate $> 1,500\text{ req/sec per pod}$.
- **Scaling Rule**: Scale horizontally from a baseline of 2 replicas up to 10 replicas.
- **Health Probes**:
  - Liveness: `GET /healthz` (Interval: 10s, Timeout: 2s, Failure Threshold: 3).
  - Readiness: `GET /readyz` (Interval: 15s, Timeout: 5s, Failure Threshold: 2).

### Background Worker Tier (`apps/worker`)

- **Metric**: Unprocessed queue backlog:
  $$\text{Queue Backlog} = \text{COUNT}(*) \text{ from events WHERE processing\_status = 'pending'}$$
- **Scaling Rule**:
  - $\text{Backlog} > 1,000$: Scale out +2 worker pods.
  - $\text{Backlog} > 3,000$: Scale out to maximum ceiling (8 worker pods).
  - $\text{Backlog} < 200$: Scale down gracefully.

---

## 5. Security & Secrets Management

1. **Bearer Token Storage**: Device tokens are stored exclusively as one-way SHA-256 hashes (`devices.key_hash`). Plaintext keys are never stored in databases, logs, or metrics.
2. **Database Authentication**: Use AWS IAM Database Authentication or GCP Cloud SQL IAM with short-lived access tokens rather than static database passwords.
3. **mTLS at Edge**: In high-security manufacturing deployments, configure mutual TLS (mTLS) termination at the Cloud Load Balancer using client certificates issued to individual edge gateways.
4. **Environment Isolation**: Production credentials (`DATABASE_URL`, `OPERATOR_SECRET_TOKEN`) must be injected via AWS Secrets Manager or HashiCorp Vault.

---

## 6. Zero-Downtime Migration & Deployment Strategy

To deploy updates without dropping edge telemetry:

1. **Database Backward Compatibility**: Database migrations (`migrations/*.sql`) must be strictly additive (new tables, new nullable columns, or new indexes). Never drop or rename columns in an active migration.
2. **Run Migrations First**: Execute `npm run migrate` in an ephemeral pre-deployment task.
3. **Rolling Container Update**:
   - Deploy new API pods using rolling updates with a minimum availability of 50%.
   - Terminate old worker pods with `SIGTERM`. The worker catches `SIGTERM`, completes its active in-flight batch, releases its advisory lock, and shuts down within a 15-second grace period.
   - Start new worker pods.
