# Architectural Decision Records (ADRs) & Trade-Off Analysis

This document records the foundational architectural decisions made in designing the Real-Time Operations Platform, detailing the problem context, alternatives evaluated, technical rationale, and accepted engineering trade-offs.

---

## ADR-001: Relational Queue with Multi-Worker Lease Fencing vs. Dedicated Brokers

### Context & Problem Statement

The platform ingests industrial telemetry that triggers incident alerts and external webhooks. If an event matches an alert threshold, the platform must:

1. Mark the event as processed.
2. Upsert an active incident (or bump its occurrence count).
3. Insert an audit event into the incident history log.
4. Schedule an external notification for downstream alerting.

If any of these steps fail independently, or if a worker crashes midway, the system risks dual-write anomalies (e.g., an alert is dispatched but the event is not marked processed, leading to duplicate alerts on restart).

### Evaluated Alternatives

1. **Apache Kafka / Redpanda**: High-throughput distributed append-only log.
2. **Redis + BullMQ**: In-memory queue with background task processing.
3. **PostgreSQL 16 as Durable Queue**: Using `FOR UPDATE SKIP LOCKED` and leased timestamp fencing.

### Decision

Adopt **PostgreSQL 16 as both the state store and the durable queue**. Workers lease batches using:

```sql
SELECT event_id, device_id, seq, ts, received_at, type, payload, attempts
FROM events
WHERE (processing_status = 'pending' AND (locked_until IS NULL OR locked_until <= NOW()))
   OR (processing_status = 'processing' AND locked_until < NOW())
ORDER BY received_at ASC
LIMIT $1
FOR UPDATE SKIP LOCKED;
```

### Rationale

- **Single ACID Transaction**: The entire state mutation (updating `events.processing_status = 'done'`, upserting `incidents`, writing `incident_events`, and inserting into `notification_outbox`) commits in a **single database transaction**. This eliminates the dual-write hazard entirely without needing a complex distributed Two-Phase Commit (2PC).
- **Zero Additional Operational Dependencies**: Developers and production operators run the full stack with one command (`docker compose up -d --build`). No ZooKeeper clusters, broker leader rebalances, or Redis persistence tuning.
- **Fair Multi-Worker Concurrency**: `FOR UPDATE SKIP LOCKED` guarantees that concurrent worker replicas claim distinct subsets of pending events without blocking each other or deadlocking.

### Trade-Offs & Mitigations

- **Write Throughput Ceiling**: Relational queues incur WAL disk syncs and B-tree index maintenance. This comfortably handles 2,500–5,000 events/second on moderate hardware, which exceeds our design requirement. For workloads exceeding 20,000 sustained writes/sec, table partitioning or dedicated commit logs (Kafka) would be required.
- **Table Bloat & VACUUM**: Rapid updates to `processing_status` require aggressive PostgreSQL autovacuum settings (`autovacuum_vacuum_scale_factor = 0.05`, `autovacuum_vacuum_cost_limit = 2000`).

---

## ADR-002: Server-Sent Events (SSE) with Sequence Replay vs. WebSockets

### Context & Problem Statement

Operators in the browser dashboard (`apps/web`) require low-latency, real-time visibility into incoming events, fleet health transitions, and newly opened incidents. If the operator's Wi-Fi drops temporarily, the dashboard must reconnect and catch up without missing intermediate alerts or requiring a manual page refresh.

### Evaluated Alternatives

1. **WebSockets (`ws` / Socket.io)**: Full-duplex persistent TCP connections.
2. **Client-Side Short Polling**: Client queries `GET /api/incidents` every 2 seconds.
3. **Server-Sent Events (SSE) with `Last-Event-ID`**: Unidirectional HTTP streaming protocol.

### Decision

Adopt **Server-Sent Events (`GET /api/stream`) backed by PostgreSQL `LISTEN / NOTIFY` on a sequential `change_log` table**.

### Rationale

- **Directional Alignment**: Dashboard operators only consume real-time telemetry. Operator commands (acknowledging incidents, resolving alerts, rotating keys) are standard REST mutations (`POST /api/incidents/:id/ack`) that benefit from HTTP status codes and semantics.
- **Native Browser Reconnection & Zero-Gap Replay**: HTML5 `EventSource` automatically reconnects and passes the `Last-Event-ID: <seq>` header. The server queries:
  ```sql
  SELECT seq, entity, op, data FROM change_log WHERE seq > $1 ORDER BY seq ASC;
  ```
  Any events missed during network dropouts are replayed seamlessly before live events resume.
- **Firewall & Proxy Compatibility**: SSE operates over plain HTTP/1.1 or multiplexed HTTP/2 (ports 80/443), passing cleanly through enterprise corporate proxies and AWS Application Load Balancers without WebSocket upgrade connection dropping.

### Trade-Offs & Mitigations

- **Connection Caps in HTTP/1.1**: Browsers limit concurrent SSE streams to 6 per domain on HTTP/1.1. In production, this is mitigated by serving over HTTP/2, where multiple streams share a single TCP connection.
- **Replay Memory Window**: The replay table is capped using a database trigger (`trg_cap_change_log`) that prunes records older than 50,000 sequence IDs. If a client is offline across > 500 events, the server emits `event: resync_required`, prompting a REST snapshot refresh.

---

## ADR-003: Database Partial Unique Indexes for Incident Deduplication

### Context & Problem Statement

When a sensor enters an anomalous state (e.g., temperature spike to 95°C), it may transmit 50 events in rapid succession. Creating 50 separate incidents creates alert fatigue and overwhelms human operators. The platform must deduplicate repeated violations to a single active incident while tracking frequency and timeline.

### Evaluated Alternatives

1. **In-Memory Cache (Redis / Local Map)**: Cache active incident IDs in worker memory.
2. **Application-Level Read-Then-Write**: Query for existing open incident before inserting.
3. **PostgreSQL Partial Unique Index**: Atomic upsert constrained at the storage layer.

### Decision

Implement **Database-Enforced Partial Unique Indexing** using:

```sql
CREATE UNIQUE INDEX idx_incidents_active_dedup
ON incidents (dedup_key)
WHERE status IN ('open', 'acknowledged');
```

And handle incident creation using:

```sql
INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, ...)
VALUES ($1, $2, $3, $4, 'open', $5, ...)
ON CONFLICT (dedup_key) WHERE status IN ('open', 'acknowledged')
DO UPDATE SET
  occurrence_count = incidents.occurrence_count + 1,
  last_seen_at = NOW(),
  last_event_id = EXCLUDED.last_event_id,
  updated_at = NOW()
RETURNING id, (xmax = 0) AS is_new, severity, occurrence_count;
```

### Rationale

- **Concurrency Immunity**: Even with 10 worker processes concurrently evaluating events from the same device, the database engine enforces single-row creation. No race conditions can generate duplicate active incidents.
- **Automatic Multi-Event Association**: Each repeat event is linked to the existing incident via `incident_events (incident_id, event_id)`, preserving complete evidentiary history.

### Trade-Offs & Mitigations

- Once an incident is marked `resolved`, its status leaves the partial index condition (`WHERE status IN ('open', 'acknowledged')`). If the condition trips again later, a brand new incident is cleanly created, which matches operational requirements.

---

## ADR-004: Transactional Outbox with Host-Level Distributed Circuit Breaker

### Context & Problem Statement

When an incident is created, alerts must be sent to external webhook endpoints (e.g., PagerDuty, Slack, or customer notification sinks). If the downstream receiver is slow or experiencing an outage, the worker must not block, lose alerts, or exhaust HTTP connection sockets.

### Evaluated Alternatives

1. **Synchronous HTTP POST during event processing**: Worker makes outbound HTTP call before committing the event.
2. **Fire-and-Forget Asynchronous Dispatch**: Fire HTTP request in background without tracking delivery.
3. **Transactional Outbox with Distributed Circuit Breaker**: Persist notification to DB inside incident transaction; dispatch via separate outbox worker with failure tracking.

### Decision

Implement the **Transactional Outbox Pattern** (`notification_outbox`) combined with a **Persistent Circuit Breaker** (`circuit_breaker_states`).

### Rationale

- **Guaranteed At-Least-Once Delivery**: Because the outbox record commits atomically with the incident, notifications cannot be lost due to process restarts.
- **Fault Isolation**: External network latencies or receiver crashes cannot slow down the primary event processing pipeline.
- **Circuit Breaker State Machine**:
  - `CLOSED`: Normal operation.
  - `OPEN`: Tripped after 5 consecutive delivery failures. Postpones requests to that host for 30 seconds without creating TCP sockets.
  - `HALF_OPEN`: Probes receiver health with a single request.
- **Idempotency Headers**: Outbound webhooks include `Idempotency-Key: <outbox_id>`, enabling receivers to discard duplicate deliveries safely.

### Trade-Offs & Mitigations

- Requires a dedicated outbox worker polling the database. Polling latency is kept under 500ms for near-instant dispatch.

---

## ADR-005: Dual-Layered Rate Limiting and Queue Backpressure

### Context & Problem Statement

A rogue or malfunctioning edge device could enter an infinite transmission loop, transmitting thousands of events per second. The platform must protect its database disk and memory from unconstrained queue growth.

### Evaluated Alternatives

1. **Unconstrained Ingestion with Database Buffering**: Accept all events until PostgreSQL storage fills up.
2. **Static Global Rate Limit**: Reject all requests once an arbitrary global RPS is reached.
3. **Dual-Layer Defense**: Per-device sliding window token bucket combined with global queue depth backpressure.

### Decision

Implement **Two-Tiered Ingestion Defense**:

1. **Tier 1 (Per-Device Rate Limiter)**: Sliding-window token bucket capping each device at 120 requests/minute.
2. **Tier 2 (Queue Backpressure Sentry)**: If pending queue depth (`SELECT COUNT(*) FROM events WHERE processing_status = 'pending'`) exceeds `QUEUE_BACKPRESSURE_THRESHOLD` (5,000 items), the gateway sheds load immediately with `HTTP 429 Too Many Requests` and `Retry-After: 5`.

### Rationale

- Protects the database from exhaustion during sustained traffic spikes.
- Distinguishes between a single misbehaving device (Tier 1 rejection) and an overall worker deficit / storage backlog (Tier 2 backpressure).
- Communicates clear backoff signals to edge hardware via standard HTTP headers.
