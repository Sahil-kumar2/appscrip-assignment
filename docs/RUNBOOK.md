# APS Platform Operational Runbook

This runbook provides diagnostic workflows, failure symptom recognition, metric thresholds, and step-by-step remediation procedures for the **Real-Time Device Operations Platform (APS)**.

---

## 1. Architecture & Diagnostic Interfaces

```
                                    +------------------------------+
                                    |   Device Fleet / Simulator   |
                                    +--------------+---------------+
                                                   | HTTP POST /v1/events
                                                   v
+------------------+   Readiness / Health   +------------------------------+
| Prometheus / SRE | <--------------------- |         apps/api             |
+------------------+                        +--------------+---------------+
                                                           | ACID Ingestion & SKIP LOCKED Queue
                                                           v
                                            +------------------------------+
                                            |     PostgreSQL 16 (SSOT)     |
                                            +--------------+---------------+
                                                           | Claim & Lease (FOR UPDATE SKIP LOCKED)
                                                           v
                                            +------------------------------+
                                            |        apps/worker           |
                                            |  - Rule Evaluator Engine     |
                                            |  - Absence & Auto-Resolution |
                                            |  - Outbox Circuit Breaker    |
                                            +--------------+---------------+
                                                           | Webhooks (Idempotency-Key)
                                                           v
                                            +------------------------------+
                                            |    apps/notification-sink    |
                                            +------------------------------+
```

### Essential Endpoints

| Endpoint                      | Purpose                                             | Normal Response                               | Failure Response                                                    |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `GET /healthz`                | Container Liveness probe                            | `200 OK` (`{"status":"ok"}`)                  | Process dead / unresponsive                                         |
| `GET /readyz`                 | Service Readiness probe (DB, migrations, queue lag) | `200 OK` (`{"status":"ready", ...}`)          | `503 Service Unavailable` (`{"status":"not_ready", "error":"..."}`) |
| `GET /metrics`                | Prometheus scraper                                  | `200 OK` (text/plain metrics)                 | `500 Internal Error`                                                |
| `GET /api/stats`              | Executive operational telemetry                     | `200 OK` (events/min, fleet, incidents)       | `401 Unauthorized` / `500 Error`                                    |
| `GET /api/events/:id/explain` | Rule match & dedup inspector                        | `200 OK` (`decision`, `decision_explanation`) | `404 Not Found`                                                     |

---

## 2. Readiness Probe & Thresholds (`/readyz`)

The `/readyz` endpoint validates three critical dependencies:

1. **Database Ping**: Verifies active connectivity to PostgreSQL 16.
2. **Schema Migrations**: Confirms migrations have executed and entries exist in `schema_migrations`.
3. **Queue Lag & Depth**: Validates that un-processed events in `events (processing_status = 'pending')` have not exceeded age or depth thresholds:
   - Max Queue Lag: `QUEUE_LAG_READY_THRESHOLD_SEC` (default: **120 seconds**).
   - Max Queue Depth: `QUEUE_PENDING_READY_THRESHOLD` (default: **5,000 events**).

```bash
# Check platform readiness
curl -s http://localhost:3000/readyz | jq .
```

---

## 3. Prometheus Key Metrics Reference

| Metric Name                                 | Type    | Description                                                                          | Alert Threshold                         |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| `aps_events_ingested_total{status}`         | Counter | Cumulative ingested events by status (`accepted`, `duplicate`, `rejected`)           | Sudden drop to 0 or spike in `rejected` |
| `aps_requests_429_total{reason}`            | Counter | Total 429 backpressure responses by reason (`queue_backpressure`, `rate_limit`)      | Rate > 10 req/sec                       |
| `aps_queue_depth{status}`                   | Gauge   | Queue event counts by status (`pending`, `processing`, `done`, `failed`)             | `pending` > 1,000 for > 2 min           |
| `aps_event_processing_failures_total`       | Gauge   | Count of dead-lettered events (`failed`)                                             | Value > 0                               |
| `aps_circuit_breaker_state{host}`           | Gauge   | State of webhook circuit breaker (`0 = CLOSED`, `1 = HALF_OPEN`, `2 = OPEN`)         | Value == 2 (`OPEN`)                     |
| `aps_incidents_by_state{state}`             | Gauge   | Incident distribution by state (`open`, `acknowledged`, `resolved`, `auto_resolved`) | Rapid accumulation of `open`            |
| `aps_notification_outbox_by_status{status}` | Gauge   | Outbox notifications by status (`pending`, `in_flight`, `sent`, `failed`, `dead`)    | `dead` > 0 or `pending` > 100           |
| `aps_sse_active_clients`                    | Gauge   | Active SSE subscriber connections                                                    | Value drops to 0 unexpectedly           |

---

## 4. Operational Failure Scenarios & Runbooks

---

### Scenario 1: Ingestion API Returning 429 (Backpressure / Rate Limit)

#### Symptoms

- Devices or simulators log `[429 BACKPRESSURE] Rate limited by API. Honouring Retry-After: Xs`.
- Metric `aps_requests_429_total` is rapidly incrementing.
- Clients receive `429 Too Many Requests` with header `Retry-After: 5`.

#### Diagnostic Steps

1. Inspect the 429 reason via Prometheus:
   ```bash
   curl -s http://localhost:3000/metrics | grep aps_requests_429_total
   ```
2. If `reason="queue_backpressure"`:
   Check pending queue count in PostgreSQL:
   ```sql
   SELECT count(*) FROM events WHERE processing_status = 'pending';
   ```
3. If `reason="rate_limit"`:
   Identify the offending device ID:
   ```bash
   curl -s http://localhost:3000/metrics | grep aps_rate_limit_rejections_total
   ```

#### Remediation

- **If caused by worker lag**: Check if workers are running:
  ```bash
  docker compose ps aps-worker
  docker compose logs --tail=50 aps-worker
  ```
  If workers are stopped or hanging, restart them:
  ```bash
  docker compose restart worker
  ```
- **If legitimate fleet surge**: Increase the backpressure threshold in environment:
  ```bash
  # In docker-compose.yml or environment:
  QUEUE_BACKPRESSURE_THRESHOLD=5000
  ```
  And reload API: `docker compose up -d api`

---

### Scenario 2: Queue Lag Spike / Events Stuck in `pending`

#### Symptoms

- `/readyz` returns HTTP `503 Service Unavailable`:
  `{"status":"not_ready","error":"Queue lag exceeded threshold (145s > 120s)"}`
- Metric `aps_queue_depth{status="pending"}` steadily rises.

#### Diagnostic Steps

1. Query the oldest un-processed pending events:
   ```sql
   SELECT event_id, device_id, seq, received_at,
          NOW() - received_at AS lag_duration,
          attempts, locked_until
   FROM events
   WHERE processing_status = 'pending'
   ORDER BY received_at ASC
   LIMIT 10;
   ```
2. Check for expired leases or stranded locks:
   ```sql
   SELECT count(*) FROM events
   WHERE processing_status = 'processing'
     AND locked_until < NOW();
   ```

#### Remediation

- Worker automatically reclaims rows whose `locked_until < NOW()`.
- To immediately force reclaim stranded processing rows:
  ```sql
  UPDATE events
  SET processing_status = 'pending', locked_until = NULL
  WHERE processing_status = 'processing' AND locked_until < NOW();
  ```
- If workers are under-provisioned, increase worker claim batch size (`EVENT_CLAIM_BATCH_SIZE=100`) or scale worker container instances:
  ```bash
  docker compose up -d --scale worker=2
  ```

---

### Scenario 3: Dead-Letter Events / Poison Payload Failures

#### Symptoms

- Metric `aps_event_processing_failures_total` > 0.
- `GET /api/dead-letters` returns events with `processing_status = 'failed'` and `attempts >= 5`.
- Web UI Ops Page displays entries in the **Dead Letters / Failed Events** table.

#### Diagnostic Steps

1. Fetch dead letter details via API:
   ```bash
   curl -s -H "Authorization: Bearer operator-secret-token" \
        http://localhost:3000/api/dead-letters | jq .
   ```
2. Inspect the failure reason in PostgreSQL:
   ```sql
   SELECT event_id, device_id, type, attempts, last_error, updated_at
   FROM events
   WHERE processing_status = 'failed'
   ORDER BY updated_at DESC
   LIMIT 10;
   ```
3. Run the Explainability inspector on the event ID:
   ```bash
   curl -s -H "Authorization: Bearer operator-secret-token" \
        http://localhost:3000/api/events/<EVENT_ID>/explain | jq .
   ```

#### Remediation

- **Fix the root cause**: If an erroneous rule expression or database timeout caused the failure, resolve the rule configuration in the Rules page.
- **Requeue a single event**:
  ```bash
  curl -s -X POST -H "Authorization: Bearer operator-secret-token" \
       http://localhost:3000/api/events/<EVENT_ID>/requeue
  ```
- **Bulk requeue all dead letters**:
  ```bash
  curl -s -X POST -H "Authorization: Bearer operator-secret-token" \
       http://localhost:3000/api/events/requeue-failed
  ```
  _(Or click **Requeue All** on the Web Console Ops page)_.

---

### Scenario 4: Webhook Notification Sink Outage / Circuit Breaker OPEN

#### Symptoms

- Log output shows:
  `{"level":"warn","msg":"CircuitBreaker is OPEN: postponing outbox delivery","host":"notification-sink:4000"}`
- Metric `aps_circuit_breaker_state{host="notification-sink:4000"}` equals `2` (`OPEN`).
- Notifications in `notification_outbox` accumulate in `failed` or `dead` status.

#### Diagnostic Steps

1. Check the circuit breaker state in the database:
   ```sql
   SELECT host, state, failure_count, updated_at FROM circuit_breaker_states;
   ```
2. Verify notification sink connectivity:
   ```bash
   curl -s http://localhost:4000/healthz
   ```
3. Check if the sink is in simulated outage mode:
   ```bash
   # Reset notification sink simulation mode to healthy
   curl -s -X POST http://localhost:4000/admin/mode \
        -H "Content-Type: application/json" \
        -d '{"mode":"ok"}'
   ```

#### Remediation

1. Restore the sink service:
   ```bash
   docker compose restart notification-sink
   ```
2. After the reset timeout (default: 10s), the breaker transitions to `HALF_OPEN`. The worker sends a probe execution. Upon success, the breaker automatically transitions back to `CLOSED`.
3. To replay all dead notifications once the sink is healthy:
   ```bash
   curl -s -X POST -H "Authorization: Bearer operator-secret-token" \
        http://localhost:3000/api/notifications/retry-dead
   ```
   _(Or click **Retry All Dead** on the Web Console Ops page)_.

---

### Scenario 5: Fleet Device Absence / Heartbeat Silence

#### Symptoms

- Devices show badges `stale` or `offline` in the Web Console.
- Open incidents appear with rule `rule-device-absence` ("Device heartbeat absent for > 60s").

#### Diagnostic Steps

1. Inspect last seen timestamps for the fleet:
   ```sql
   SELECT id, name, status, last_seen_at,
          NOW() - last_seen_at AS silence_duration
   FROM devices
   ORDER BY last_seen_at ASC NULLS FIRST;
   ```
2. Verify if the simulator is transmitting:
   ```bash
   docker compose logs --tail=20 aps-simulator
   ```

#### Remediation

- Once the device or simulator resumes transmitting events, the worker **automatically resolves** active absence incidents on the very next received event:
  - Incident transitions to status `auto_resolved`.
  - An entry is recorded in `incident_history` with actor `device_resume`.
  - Device status transitions from `offline` -> `online` with a corresponding `change_log` row.

---

### Scenario 6: Real-Time SSE Stream Disconnections / Replay Buffer Exceeded

#### Symptoms

- Web UI banner displays `RECONNECTING` or `OFFLINE SINCE HH:MM`.
- Web console receives an SSE event:
  `event: resync_required`
  `data: {"action":"resync_required","reason":"SSE replay gap exceeded limit"}`

#### Diagnostic Steps

1. Inspect active SSE subscriber count:
   ```bash
   curl -s http://localhost:3000/metrics | grep aps_sse_active_clients
   ```
2. Compare the client's `Last-Event-ID` with the database maximum sequence:
   ```sql
   SELECT max(seq) as current_max_seq FROM change_log;
   ```
3. Check PostgreSQL notify queue health:
   ```sql
   SELECT count(*) FROM change_log WHERE created_at > NOW() - interval '5 minutes';
   ```

#### Remediation

- When `resync_required` is emitted (client replay gap > 500 events), the web client's `PlatformContext` **automatically performs a full REST refetch** (`/api/stats`, `/api/devices`, `/api/incidents`, `/api/rules`) and resets its `Last-Event-ID` to current head.
- Ensure reverse proxies (Nginx / Cloudflare) do not buffer SSE responses:
  `proxy_buffering off;` and `proxy_read_timeout 86400s;`.

---

### Scenario 7: PostgreSQL Advisory Lock Contention or Connection Exhaustion

#### Symptoms

- Worker or API startup hangs on `SELECT pg_advisory_lock(...)`.
- Error logs show `remaining connection slots are reserved for non-replication superuser connections` or `timeout acquiring connection from pool`.

#### Diagnostic Steps

1. Check active database connections:
   ```sql
   SELECT count(*), state FROM pg_stat_activity GROUP BY state;
   ```
2. Inspect held advisory locks:
   ```sql
   SELECT pid, locktype, mode, granted
   FROM pg_locks
   WHERE locktype = 'advisory';
   ```
3. Check slow queries:
   ```sql
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE (now() - pg_stat_activity.query_start) > interval '5 seconds'
     AND state != 'idle';
   ```

#### Remediation

- If a killed process left an advisory lock held, terminate the backend connection:
  ```sql
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = <BLOCKED_PID>;
  ```
- Increase `DATABASE_POOL_SIZE` or `max_connections` in `postgresql.conf` if concurrent workers or API replicas scale up.

---

## 5. Operator Quick Reference Cheat Sheet

### Common Curl Diagnostics

```bash
# 1. Platform Liveness
curl -s http://localhost:3000/healthz

# 2. Platform Readiness & Queue Lag
curl -s http://localhost:3000/readyz

# 3. Prometheus Metrics Scrape
curl -s http://localhost:3000/metrics

# 4. Fleet & Operational Statistics
curl -s -H "Authorization: Bearer operator-secret-token" http://localhost:3000/api/stats

# 5. Explain an Event
curl -s -H "Authorization: Bearer operator-secret-token" http://localhost:3000/api/events/<EVENT_ID>/explain

# 6. Requeue Failed Dead Letters
curl -s -X POST -H "Authorization: Bearer operator-secret-token" http://localhost:3000/api/events/requeue-failed

# 7. Retry Dead Notifications
curl -s -X POST -H "Authorization: Bearer operator-secret-token" http://localhost:3000/api/notifications/retry-dead
```

### Common Docker Operations

```bash
# Start complete platform
docker compose up --build -d

# Check all container states
docker compose ps

# View unified structured logs
docker compose logs -f --tail=50

# Restart background queue worker
docker compose restart worker

# Trigger failure test in notification sink
curl -X POST http://localhost:4000/admin/mode -H "Content-Type: application/json" -d '{"mode":"fail"}'

# Recover notification sink
curl -X POST http://localhost:4000/admin/mode -H "Content-Type: application/json" -d '{"mode":"ok"}'
```
