# Edge Telemetry Protocol Specification (ETP/1.0)

## 1. Overview & Protocol Contract

This document specifies the communication contract between industrial edge devices (or edge gateways) and the Operations Platform Ingestion Gateway (`POST /v1/events`).

The protocol is designed for constrained networks, intermittent cellular links, and harsh industrial environments where at-least-once delivery, edge buffering, and idempotent deduplication are mandatory.

---

## 2. Telemetry Event Schema (`schema_version: 1`)

Each telemetry event is represented as a JSON object adhering to the schema defined below:

```typescript
interface EdgeTelemetryEvent {
  /** Globally unique UUIDv4 identifier generated at edge observation time */
  event_id: string;

  /** Authenticated hardware device identifier (e.g. 'edge-austin-press-01') */
  device_id: string;

  /** Monotonically increasing sequence number per device (starts at 1) */
  seq: number;

  /** ISO 8601 UTC timestamp of edge observation (e.g. '2026-10-26T14:30:00.000Z') */
  ts: string;

  /** Dot-delimited event taxonomy string (e.g. 'telemetry', 'hardware.fault', 'heartbeat') */
  type: string;

  /** Arbitrary domain payload (key-value pairs, nested telemetry metrics) */
  payload: Record<string, unknown>;

  /** Protocol schema version; strictly integer 1 */
  schema_version: 1;
}
```

### Field Constraints & Invariants

| Field            | Type      | Validation Invariants & Error Handling                                                                                                                                                      |
| :--------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event_id`       | `string`  | Must be a valid UUIDv4 string. Used as the global idempotency key.                                                                                                                          |
| `device_id`      | `string`  | Must exactly match the identity bound to the `Bearer` token in the request. Submitting events for other device IDs triggers immediate rejection.                                            |
| `seq`            | `integer` | Strictly positive integer ($\ge 1$). While monotonic at the edge, out-of-order arrival due to network re-routing is accepted; database telemetry tracks `GREATEST(last_seq, seq)`.          |
| `ts`             | `string`  | Valid ISO 8601 UTC timestamp format. **Clock Skew Guard**: If $ts > \text{NOW}() + 5\text{ minutes}$, the event is rejected individually. Server stamps storage with `received_at = NOW()`. |
| `type`           | `string`  | Non-empty classification string (max 100 characters).                                                                                                                                       |
| `payload`        | `object`  | JSON object containing metrics (e.g. `temperature`, `vibration_rms`, `pressure`).                                                                                                           |
| `schema_version` | `integer` | Must be strictly `1`.                                                                                                                                                                       |

---

## 3. Ingestion Endpoint Specification

### `POST /v1/events`

Ingests an array of 1 to 500 telemetry events in a single HTTP request.

#### HTTP Headers

| Header             | Required | Value / Format            | Description                                                                                  |
| :----------------- | :------- | :------------------------ | :------------------------------------------------------------------------------------------- |
| `Authorization`    | **Yes**  | `Bearer <raw_device_key>` | Secret key provisioned during device commissioning (e.g. `Bearer sec_live_austin_press_01`). |
| `Content-Type`     | **Yes**  | `application/json`        | Enforces JSON encoding.                                                                      |
| `X-Correlation-ID` | No       | UUID string               | Optional caller-provided tracing identifier propagated into structured server logs.          |

#### Request Payload Example

```json
[
  {
    "event_id": "7f8b9c1d-2e3f-4a5b-8c9d-0e1f2a3b4c5d",
    "device_id": "edge-austin-press-01",
    "seq": 4012,
    "ts": "2026-10-26T14:30:00.000Z",
    "type": "telemetry",
    "payload": {
      "hydraulic_pressure_psi": 2840.5,
      "temperature_celsius": 82.3,
      "cycle_count": 14209
    },
    "schema_version": 1
  },
  {
    "event_id": "8a9b0c1d-3e4f-5a6b-9c0d-1e2f3a4b5c6e",
    "device_id": "edge-austin-press-01",
    "seq": 4013,
    "ts": "2026-10-26T14:30:01.000Z",
    "type": "telemetry",
    "payload": {
      "hydraulic_pressure_psi": 2910.1,
      "temperature_celsius": 86.7,
      "cycle_count": 14210
    },
    "schema_version": 1
  }
]
```

---

## 4. Ingestion Responses & Per-Record Status

### 4.1. Success & Partial Success (`HTTP 200 OK`)

The gateway validates every event individually. If the batch contains a mix of fresh events, network retries, and invalid payloads, the endpoint commits all valid records and returns an itemized outcome array:

```json
{
  "results": [
    {
      "event_id": "7f8b9c1d-2e3f-4a5b-8c9d-0e1f2a3b4c5d",
      "status": "accepted"
    },
    {
      "event_id": "8a9b0c1d-3e4f-5a6b-9c0d-1e2f3a4b5c6e",
      "status": "accepted"
    },
    {
      "event_id": "7f8b9c1d-2e3f-4a5b-8c9d-0e1f2a3b4c5d",
      "status": "duplicate",
      "reason": "Event already accepted for device"
    },
    {
      "event_id": "9b0c1d2e-4f5a-6b7c-0d1e-2f3a4b5c6d7e",
      "status": "rejected",
      "reason": "Timestamp cannot be more than 5 minutes in the future"
    }
  ]
}
```

#### Outcome Status Semantics:

- **`accepted`**: Valid, novel event committed to PostgreSQL storage and marked `processing_status = 'pending'`.
- **`duplicate`**: Event with identical `(device_id, event_id)` already exists in database. No new row is inserted; no duplicate incident or rule evaluation occurs.
- **`rejected`**: Event failed schema validation, device ID mismatch, or clock-skew rule. Record is logged to `rejected_events` audit buffer for debugging.

---

### 4.2. Gateway Error Responses

| Status Code               | Reason / Condition                                             | Sample Response Body                                          | Client Action                                                                               |
| :------------------------ | :------------------------------------------------------------- | :------------------------------------------------------------ | :------------------------------------------------------------------------------------------ |
| `400 Bad Request`         | Batch payload is not a JSON array, or exceeds 500 items.       | `{"error": "Payload must be an array of at most 500 events"}` | Correct batch size and format before re-sending.                                            |
| `401 Unauthorized`        | Missing or invalid `Authorization: Bearer <key>` header.       | `{"error": "Invalid or missing device credentials"}`          | Verify provisioned key; halt transmission if persistent.                                    |
| `413 Payload Too Large`   | Raw body exceeds the 10 MB payload ceiling.                    | `{"error": "Request body size exceeds 10MB limit"}`           | Decrease batch size to $\le 500$ events.                                                    |
| `429 Too Many Requests`   | Device exceeded rate limit or pending queue exceeds threshold. | `{"error": "Queue backpressure active", "retry_after": 5}`    | **Hold transmissions** in edge buffer; sleep for seconds indicated in `Retry-After` header. |
| `503 Service Unavailable` | Database connection lost or storage read-only.                 | `{"error": "Database unavailable"}`                           | Buffer records locally and retry with exponential backoff and jitter.                       |

---

## 5. Edge Hardware Transmission Guidelines

1. **Persistent Local Circular Buffering**:
   - Hardware units should buffer telemetry in non-volatile flash memory (e.g. SQLite or circular ring buffers).
   - In the event of cellular loss or HTTP 429 / 503 errors, data must be preserved until an acknowledgment (`status: 'accepted'` or `'duplicate'`) is received.
2. **Backoff with Full Jitter**:
   - When encountering transient errors, edge devices must calculate backoff delays as:
     $$T_{\text{wait}} = \min(T_{\text{max}}, \; T_{\text{base}} \times 2^{\text{attempt}}) \times \text{random}(0.5, 1.5)$$
   - Respect the `Retry-After` HTTP header if present.
3. **Idempotency Guarantee**:
   - Resending a buffered batch after a network timeout is safe. The platform’s database-level `ON CONFLICT (device_id, event_id) DO NOTHING` prevents duplicate processing.
