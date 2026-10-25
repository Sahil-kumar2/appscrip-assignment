# Architectural Decisions & Trade-Offs

This document records the core architectural decisions made in designing and implementing the Real-Time Device Operations Platform, the alternatives considered, and the deliberate trade-offs accepted.

---

## 1. PostgreSQL as Single Source of Truth & Durable Queue

### Decision

Use PostgreSQL 16 for both entity storage and the durable event queue (using `events.processing_status`, `locked_until`, and `SELECT ... FOR UPDATE SKIP LOCKED`).

### Alternatives Considered

1. **Apache Kafka / Redpanda**: Dedicated distributed commit log.
2. **Redis + BullMQ / Celery**: In-memory Redis queue with worker libraries.
3. **RabbitMQ / SQS**: Traditional AMQP or cloud message queues.

### Why Chosen

- **Zero Dual-Write Hazard**: When an event matches a rule, the incident upsert, occurrence count increment, incident history audit, outbox notification insert, and marking the event `done` are executed in a **single ACID database transaction**. With Kafka or Redis, achieving atomicity across queuing and database storage requires two-phase commits (2PC) or an external outbox pattern, introducing dual-write inconsistencies during network partitions or mid-transaction crashes.
- **Runnability & Zero Extra Infrastructure**: The entire stack boots with a single command (`docker compose up --build`). No ZooKeeper, broker clusters, or stateful Redis persistence configurations.
- **Fair Multi-Worker Concurrency**: PostgreSQL's `FOR UPDATE SKIP LOCKED` allows any number of concurrent worker processes to claim event batches without contention or row locking deadlocks.

### Trade-Offs & Limitations

- **Ingestion Throughput Cap**: PostgreSQL write throughput is bound by WAL disk sync and row-level indexing overhead. Comfortably handles 2,000–5,000 events/second on standard SSDs; above 10,000–20,000 sustained writes/sec, partitioning, table unlogging, or dedicated commit logs (Kafka) become necessary.
- **Table Bloat & VACUUM**: Rapid `UPDATE` operations on queue rows require tuned autovacuum (`autovacuum_vacuum_scale_factor = 0.05`, `autovacuum_vacuum_cost_limit = 2000`) or partitioning by time.

---

## 2. Server-Sent Events (SSE) over WebSockets

### Decision

Use Server-Sent Events (`GET /api/stream`) with HTTP `Last-Event-ID` replay for real-time dashboard telemetry, backed by PostgreSQL `LISTEN/NOTIFY`.

### Alternatives Considered

1. **WebSockets (ws / socket.io)**: Full duplex TCP bidirectional connection.
2. **Short Polling**: Client polls REST endpoints every 1–2 seconds.
3. **Long Polling**: Hanging HTTP requests.

### Why Chosen

- **Unidirectional Match**: Dashboard operators only consume real-time updates (incidents, status changes, events); client actions (acknowledging an incident, rotating device keys) are standard HTTP mutations with explicit request/response status codes.
- **Native Browser Reconnection & Replay**: HTML5 `EventSource` automatically reconnects upon network failure and transmits the `Last-Event-ID` header. The server seamlessly queries `change_log WHERE seq > $1` to deliver missed updates with zero gaps or duplicates.
- **HTTP/2 & Proxy Friendly**: Works over standard HTTP ports (80/443), passes through corporate firewalls, reverse proxies, and ALBs without sticky WebSocket upgrade headers.

### Trade-Offs & Limitations

- **HTTP/1.1 Connection Limit**: In HTTP/1.1, browsers enforce a limit of 6 open connections per domain. Solved in production by serving over HTTP/2 where multiplexing supports multiple streams per single TCP connection.
- **Unidirectional Only**: Client cannot push messages upstream over the same channel; client actions use standard REST endpoints (`POST /api/incidents/:id/ack`).

---

## 3. Batch HTTP Ingestion over MQTT

### Decision

Adopt HTTP/1.1 REST with JSON array batches (`POST /v1/events`, up to 500 events) and Bearer token authentication.

### Alternatives Considered

1. **MQTT (Message Queuing Telemetry Transport)**: Lightweight binary pub/sub protocol over TCP.
2. **gRPC / Protocol Buffers**: High-performance RPC over HTTP/2.
3. **CoAP (Constrained Application Protocol)**: UDP-based IoT protocol.

### Why Chosen

- **Simplicity & Ubiquity**: Every IoT cellular gateway, edge container, and development environment supports standard HTTP client libraries without specialized broker daemons or socket-level reconnect management.
- **Per-Event Response Contract**: Returning HTTP 200 with per-event status (`accepted`, `duplicate`, `rejected`) gives the sending device immediate confirmation of which events were saved to disk and which need resubmission.
- **Batch Efficiency**: Bundling 100–500 events per HTTP request amortizes TLS handshake and network latency, matching or exceeding per-message MQTT throughput on edge devices.

### Trade-Offs & Limitations

- **Bandwidth Overhead**: JSON headers and field keys consume more bytes over the wire compared to binary Protobuf or MQTT packed telemetry.
- **No Push to Device**: The platform cannot push ad-hoc commands to offline devices without an external polling mechanism or push agent.

---

## 4. Transactional Outbox with Per-Host Circuit Breaker

### Decision

Persist alert notifications to a `notification_outbox` table in the incident transaction, delivered asynchronously by `OutboxWorker` with exponential backoff, full random jitter, and a per-host `CircuitBreaker`.

### Alternatives Considered

1. **Synchronous Webhook in Ingestion Loop**: Direct HTTP call to operator webhook during event processing.
2. **Detached Worker Event Emitting**: Worker emits webhook without persisting an outbox record.

### Why Chosen

- **Failure Decoupling**: If an operator's webhook sink or pager service goes down, incident creation and event processing **never fail or block**.
- **Circuit Breaker Protection**: Tripping to `OPEN` after repeated failures halts outgoing HTTP requests to the dead endpoint, preventing worker starvation, socket exhaustion, and cascading timeouts.
- **At-Least-Once Delivery**: Storing `notification_outbox` durably guarantees notifications are never lost, retrying until delivered or explicitly dead-lettered.

### Trade-Offs & Limitations

- **Slight Alert Latency**: Notifications are dispatched asynchronously on the next worker poll (~200–500ms latency) rather than sub-millisecond synchronous execution.

---

## 5. Pure Rule Engine with In-Memory TTL Cache

### Decision

Implement rule evaluation as a pure, unit-testable TypeScript function (`evaluateRule`) decoupled from database operations, using a short-TTL in-memory cache (`RuleCache`, 5s TTL) for active rule definitions.

### Alternatives Considered

1. **SQL-Only Rule Execution**: Embedding threshold and absence checks directly in complex SQL trigger queries.
2. **External Rule Engines (Drools, JSON-Rules-Engine)**: Heavy external rule management engines.

### Why Chosen

- **Testability & Determinism**: Pure functions enable exhaustive unit testing (testing thresholds, null payloads, missing fields, type mismatches) with zero database dependencies.
- **Database Load Reduction**: Caching active rules in memory eliminates repetitive `SELECT * FROM rules` queries across millions of claimed events.
- **Explainability**: Pure evaluations return human-readable `reason` strings and boolean `matched` flags directly stored in `rule_evaluations` for auditability.

### Trade-Offs & Limitations

- **Propagation Delay**: When an operator updates a rule via `PATCH /api/rules/:id`, worker instances may take up to 5 seconds to observe the update unless `invalidateRuleCache()` is triggered.
