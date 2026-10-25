# SRE & Forward Deployed Engineer Operations Runbook

This runbook provides frontline SREs and Forward Deployed Engineers with actionable diagnostic procedures, failure symptom recognition, metric thresholds, and step-by-step remediation commands for the Real-Time Operations Platform.

---

## 1. Operational Diagnostic Endpoints

| Endpoint                | Protocol | Purpose & Normal Response                                           | Alert / Incident Trigger                                           |
| :---------------------- | :------- | :------------------------------------------------------------------ | :----------------------------------------------------------------- |
| `GET /healthz`          | HTTP     | Container liveness. Returns `200 OK` (`{"status":"ok"}`).           | Container unresponsive or crashed. Restart pod.                    |
| `GET /readyz`           | HTTP     | Deep readiness check. Returns `200 OK` (`{"status":"ready", ...}`). | Returns `503 Service Unavailable`. Pod removed from load balancer. |
| `GET /metrics`          | HTTP     | Prometheus metrics output (`text/plain`).                           | Scraper times out or returns `500`.                                |
| `GET /api/stats`        | HTTP     | Fleet health, queue depth, and ingestion rate counters.             | High queue backlog or unexpected offline fleet ratio.              |
| `GET /api/dead-letters` | HTTP     | List of unprocessable failed events.                                | Non-zero count indicates poison payloads or worker bugs.           |

---

## 2. Readiness Probe Logic (`/readyz`)

The `/readyz` probe performs automated real-time checks across three subsystems:

1. **Database Ping**: Verifies connectivity to PostgreSQL 16 within a 2-second timeout.
2. **Migration Consistency**: Verifies applied schema migrations exist in `schema_migrations`.
3. **Queue Health Constraints**:
   - **Queue Lag**: Ensures the age of the oldest unprocessed pending event is under `QUEUE_LAG_READY_THRESHOLD_SEC` (default: **120 seconds**).
   - **Queue Depth**: Ensures the count of pending events is under `QUEUE_PENDING_READY_THRESHOLD` (default: **5,000 events**).

If either queue threshold is breached, `/readyz` fails with `HTTP 503`, causing cloud load balancers to temporarily stop routing new requests to the saturated node.

---

## 3. Incident Triage Playbooks

### Playbook 1: Elevated Queue Backlog & Ingestion Lag

**Symptom**: `QUEUE_PENDING_READY_THRESHOLD` breached; dashboard shows growing unprocessed count.

#### Diagnosis:

1. Check count of unprocessed events:
   ```bash
   docker compose exec api curl -sf http://localhost:3000/api/stats | grep -o '"pending":[0-9]*'
   ```
2. Check worker container logs for errors or lock starvation:
   ```bash
   docker compose logs --tail=100 worker
   ```
3. Inspect active PostgreSQL queries:
   ```sql
   SELECT pid, now() - query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE state != 'idle' AND query ILIKE '%events%'
   ORDER BY duration DESC;
   ```

#### Remediation:

- **Horizontal Scaling**: Scale worker replicas to increase parallel batch processing:
  ```bash
  docker compose up -d --scale worker=3
  ```
- **Check for Blocked Leases**: If workers crashed without completing, wait for the 30-second lease timeout (`locked_until < NOW()`) or manually release stale locks:
  ```sql
  UPDATE events
  SET processing_status = 'pending', locked_until = NULL
  WHERE processing_status = 'processing' AND locked_until < NOW();
  ```

---

### Playbook 2: Circuit Breaker Tripped (`OPEN`) on Outbox Webhooks

**Symptom**: Outbound notifications are not reaching the downstream operator sink; `circuit_breaker_states` indicates `OPEN`.

#### Diagnosis:

1. Inspect current circuit breaker status:
   ```sql
   SELECT host, state, consecutive_failures, last_failure_at
   FROM circuit_breaker_states;
   ```
2. Check outbox records in `failed` or `dead` state:
   ```sql
   SELECT status, COUNT(*) FROM notification_outbox GROUP BY status;
   ```

#### Remediation:

1. Confirm downstream endpoint health:
   ```bash
   curl -i http://localhost:4000/health
   ```
2. If downstream endpoint was in simulated chaos mode, reset it to healthy:
   ```bash
   curl -X POST http://localhost:4000/admin/mode -H "Content-Type: application/json" -d '{"mode":"ok"}'
   ```
3. Manually reset the circuit breaker in the database:
   ```sql
   UPDATE circuit_breaker_states
   SET state = 'CLOSED', consecutive_failures = 0
   WHERE host = 'notification-sink:4000';
   ```
4. Re-queue dead notifications for delivery:
   ```bash
   curl -X POST http://localhost:3000/api/incidents/<incident_id>/notifications/retry \
     -H "Authorization: Bearer operator-secret-token"
   ```

---

### Playbook 3: Poison Pills in Dead-Letter Queue

**Symptom**: Events appear in `GET /api/dead-letters` with `processing_status = 'failed'`.

#### Diagnosis:

1. Retrieve dead-lettered events and error details:
   ```bash
   curl -s -H "Authorization: Bearer operator-secret-token" \
     http://localhost:3000/api/dead-letters | jq .
   ```
2. Inspect the `last_error` field to identify whether the failure is schema mismatch, missing rule field, or code exception.

#### Remediation:

1. If the failure was due to an updated rule definition or transient dependency, re-queue the failed events for another processing attempt:
   ```bash
   curl -X POST http://localhost:3000/api/dead-letters/requeue \
     -H "Authorization: Bearer operator-secret-token" \
     -H "Content-Type: application/json" \
     -d '{"event_ids": ["<failed-event-uuid>"]}'
   ```

---

### Playbook 4: Device Key Rotation & Emergency Decommissioning

**Symptom**: An edge device's Bearer token is leaked, compromised, or requires scheduled rotation.

#### Remediation:

1. Rotate the device key via the Operator API:
   ```bash
   curl -X POST http://localhost:3000/api/devices/edge-austin-press-01/rotate-key \
     -H "Authorization: Bearer operator-secret-token"
   ```
   _Response provides the new plaintext secret token once. Store it immediately._
2. Update the hardware edge device with the newly generated bearer key.
3. Verify new events are accepted:
   ```bash
   curl -X POST http://localhost:3000/v1/events \
     -H "Authorization: Bearer <new-key>" \
     -H "Content-Type: application/json" \
     -d '[{"event_id":"...","device_id":"edge-austin-press-01","seq":1,"ts":"...","type":"telemetry","payload":{},"schema_version":1}]'
   ```

---

## 4. Recommended Prometheus Alerting Rules

```yaml
groups:
  - name: aps_alerts
    rules:
      - alert: APSIngestionQueueBacklogHigh
        expr: aps_queue_depth_pending > 3000
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: 'APS event queue backlog exceeds 3,000 pending events'
          description: 'Worker processing throughput is falling behind ingestion rate.'

      - alert: APSCircuitBreakerOpen
        expr: aps_circuit_breaker_state{state="OPEN"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'Notification circuit breaker tripped to OPEN'
          description: 'Downstream webhook delivery failing repeatedly for host {{ $labels.host }}.'

      - alert: APSDeadLetterQueueAccumulation
        expr: rate(aps_event_processing_failures_total[5m]) > 0.1
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: 'Events are entering the dead-letter queue'
          description: 'Poison payloads or worker evaluation bugs detected.'
```
