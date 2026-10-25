import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';
import { ApiConfig } from '../config.js';
import { hashDeviceKey } from '@aps/shared';

describe('API Server Integration Routes', () => {
  const config: ApiConfig = {
    PORT: 3000,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/aps',
    QUEUE_BACKPRESSURE_THRESHOLD: 100,
    LATE_EVENT_WINDOW_SECONDS: 300,
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 10,
    OPERATOR_TOKEN: 'operator-secret-token',
    LOG_LEVEL: 'silent',
    effectiveMaxPending: 100,
  };

  let mockPool: any;
  let mockClient: any;
  let app: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(mockClient),
      on: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };

    app = buildServer(config, mockPool);
  });

  describe('GET /healthz and GET /readyz', () => {
    it('returns 200 on /healthz', async () => {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });

    it('returns ready status and queue lag metrics on /readyz', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // ping
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // migrations applied
        .mockResolvedValueOnce({ rows: [{ pending_count: '5', oldest_pending_age_seconds: '12' }] }) // queue lag
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }); // outbox

      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.status).toBe('ready');
      expect(data.migrations.applied).toBe(true);
      expect(data.queue_lag.pending_count).toBe(5);
      expect(data.queue_lag.oldest_pending_age_seconds).toBe(12);
    });

    it('returns 503 if no migrations are applied on /readyz', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // ping
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // 0 migrations applied

      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('not_ready');
      expect(res.json().error).toContain('No database migrations applied');
    });

    it('returns 503 if queue lag exceeds threshold on /readyz', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // ping
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // migrations applied
        .mockResolvedValueOnce({
          rows: [{ pending_count: '10', oldest_pending_age_seconds: '250' }],
        }); // queue lag 250s > 120s

      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('not_ready');
      expect(res.json().error).toContain('Queue lag exceeded threshold');
    });

    it('returns 503 if DB is down on /readyz', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('not_ready');
    });
  });

  describe('GET /metrics', () => {
    it('returns prometheus metrics text including ingest, queue depth, and circuit breaker', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ processing_status: 'pending', count: '3' }] }) // queue depth
        .mockResolvedValueOnce({ rows: [{ status: 'open', count: '1' }] }) // incidents
        .mockResolvedValueOnce({ rows: [{ status: 'pending', count: '2' }] }) // outbox
        .mockResolvedValueOnce({ rows: [{ total_attempts: '15', failures: '1' }] }) // attempts & failures
        .mockResolvedValueOnce({ rows: [{ host: 'notification-sink:4000', state: 'CLOSED' }] }); // circuit breaker

      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      const body = res.payload;
      expect(body).toContain('aps_events_ingested_total');
      expect(body).toContain('aps_requests_429_total');
      expect(body).toContain('aps_queue_depth');
      expect(body).toContain('aps_incidents_by_state');
      expect(body).toContain('aps_notification_outbox_by_status');
      expect(body).toContain('aps_event_processing_attempts_total');
      expect(body).toContain('aps_event_processing_failures_total');
      expect(body).toContain('aps_circuit_breaker_state');
      expect(body).toContain('aps_sse_active_clients');
    });
  });

  describe('POST /v1/events authentication & backpressure', () => {
    it('rejects requests without Bearer token with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        payload: [],
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects invalid device key with 401', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // device not found
      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { authorization: 'Bearer invalid-secret' },
        payload: [],
      });
      expect(res.statusCode).toBe(401);
    });

    it('enforces backpressure when queue depth exceeds threshold', async () => {
      const key = 'secret-key-1';
      const keyHash = hashDeviceKey(key);

      // Device exists
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'dev-001', location_id: 'loc-1', status: 'online', last_seq: 0, key_hash: keyHash },
        ],
      });

      // Pending depth check: returns 150 (threshold is 100)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ count: '150' }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { authorization: `Bearer ${key}` },
        payload: [
          {
            event_id: '123e4567-e89b-12d3-a456-426614174000',
            device_id: 'dev-001',
            seq: 1,
            ts: new Date().toISOString(),
            type: 'telemetry',
            payload: {},
            schema_version: 1,
          },
        ],
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json().error).toContain('backpressure');
    });
  });

  describe('Event ingestion results: accepted, duplicate, rejected', () => {
    it('processes batch with accepted, duplicate, and rejected items', async () => {
      const key = 'test-key';
      const keyHash = hashDeviceKey(key);
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'dev-001', location_id: 'loc-1', status: 'online', last_seq: 5, key_hash: keyHash },
        ],
      });
      // Queue depth normal (10 pending)
      mockPool.query.mockResolvedValueOnce({
        rows: [{ count: '10' }],
      });

      // Client transaction mocks
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        // Item 1: Accepted
        .mockResolvedValueOnce({ rows: [{ event_id: '11111111-1111-1111-1111-111111111111' }] }) // insert event returns row
        .mockResolvedValueOnce({}) // change_log insert
        // Item 2: Duplicate
        .mockResolvedValueOnce({ rows: [] }) // insert event returns 0 rows (conflict)
        // Item 3 is rejected due to future timestamp > 5 mins
        .mockResolvedValueOnce({}) // insert rejected_events
        .mockResolvedValueOnce({}) // update devices
        .mockResolvedValueOnce({}); // COMMIT

      const validTs = new Date().toISOString();
      const futureTs = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min in future

      const batch = [
        {
          event_id: '11111111-1111-1111-1111-111111111111',
          device_id: 'dev-001',
          seq: 6,
          ts: validTs,
          type: 'telemetry',
          payload: { temperature: 22 },
          schema_version: 1,
        },
        {
          event_id: '22222222-2222-2222-2222-222222222222',
          device_id: 'dev-001',
          seq: 5,
          ts: validTs,
          type: 'telemetry',
          payload: { temperature: 21 },
          schema_version: 1,
        },
        {
          event_id: '33333333-3333-3333-3333-333333333333',
          device_id: 'dev-001',
          seq: 7,
          ts: futureTs,
          type: 'telemetry',
          payload: {},
          schema_version: 1,
        },
      ];

      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { authorization: `Bearer ${key}` },
        payload: batch,
      });

      expect(res.statusCode).toBe(200);
      const results = res.json().results;
      expect(results).toHaveLength(3);

      expect(results[0].status).toBe('accepted');
      expect(results[1].status).toBe('duplicate');
      expect(results[2].status).toBe('rejected');
      expect(results[2].reason).toContain('in the future');
    });
  });

  describe('GET /api/events/:id/explain', () => {
    it('returns event and rule evaluations', async () => {
      const eventId = '11111111-1111-1111-1111-111111111111';
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ event_id: eventId, device_id: 'dev-001', type: 'telemetry' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              event_id: eventId,
              rule_id: 'rule-temp-high',
              rule_name: 'High Temp',
              matched: true,
              reason: 'Payload temperature (92) > 85',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [], // incident
        });

      const res = await app.inject({
        method: 'GET',
        url: `/api/events/${eventId}/explain`,
        headers: { authorization: 'Bearer operator-secret-token' },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.event.event_id).toBe(eventId);
      expect(data.evaluations).toHaveLength(1);
      expect(data.evaluations[0].matched).toBe(true);
      expect(data.evaluations[0].reason).toContain('temperature (92) > 85');
    });
  });
});
