import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../server.js';
import { loadApiConfig } from '../config.js';
import { hashDeviceKey } from '@aps/shared';

describe('Operator-Facing APIs & Real-Time SSE Stream (Real PostgreSQL)', () => {
  const connectionString =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString });

  const OPERATOR_TOKEN = 'test-operator-bearer-token';
  const apiConfig = loadApiConfig({
    DATABASE_URL: connectionString,
    OPERATOR_TOKEN,
    LOG_LEVEL: 'silent',
  });
  const app = buildServer(apiConfig, pool);

  const authHeaders = {
    authorization: `Bearer ${OPERATOR_TOKEN}`,
  };

  const testLocationId = `loc-op-test-${Date.now()}`;
  let testDeviceId: string;
  let testRuleId: string;

  beforeAll(async () => {
    // Insert test location
    await pool.query(
      `INSERT INTO locations (id, name) VALUES ($1, 'Operator Test Lab')
       ON CONFLICT (id) DO NOTHING`,
      [testLocationId]
    );
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM incident_history WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query('DELETE FROM incidents WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM events WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM devices WHERE location_id = $1', [testLocationId]);
    await pool.query('DELETE FROM rules WHERE id LIKE $1', [`test-rule-${testLocationId}%`]);
    await pool.query('DELETE FROM locations WHERE id = $1', [testLocationId]);
    await app.close();
    await pool.end();
  });

  describe('1. Operator Bearer Token Authentication', () => {
    it('rejects /api/devices without Authorization header with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/devices',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or missing operator bearer token');
    });

    it('rejects /api/devices with invalid Bearer token with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/devices',
        headers: { authorization: 'Bearer wrong-secret-token' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or missing operator bearer token');
    });

    it('allows /api/devices with valid Bearer token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/devices',
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().devices)).toBe(true);
    });

    it('allows /api/stream with token in query param (?token=)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/stream?close_after_replay=true&token=${OPERATOR_TOKEN}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
    });
  });

  describe('2. Device Management & Key Rotation', () => {
    it('creates a new device via POST /api/devices, hashes key, and returns raw key once', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/devices',
        headers: authHeaders,
        payload: {
          name: 'Op Test Sensor',
          location_id: testLocationId,
        },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.device).toBeDefined();
      expect(data.device.name).toBe('Op Test Sensor');
      expect(data.raw_key).toBeDefined();
      expect(typeof data.raw_key).toBe('string');
      expect(data.raw_key.length).toBeGreaterThan(20);

      testDeviceId = data.device.id;

      // Verify device in DB has hashed key, never raw key
      const dbRes = await pool.query<{ key_hash: string }>(
        'SELECT key_hash FROM devices WHERE id = $1',
        [testDeviceId]
      );
      expect(dbRes.rows[0].key_hash).toBe(hashDeviceKey(data.raw_key));
    });

    it('rotates device key via POST /api/devices/:id/rotate-key and records change_log', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/devices/${testDeviceId}/rotate-key`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.device_id).toBe(testDeviceId);
      expect(data.raw_key).toBeDefined();

      const newKeyHash = hashDeviceKey(data.raw_key);
      const dbRes = await pool.query<{ key_hash: string }>(
        'SELECT key_hash FROM devices WHERE id = $1',
        [testDeviceId]
      );
      expect(dbRes.rows[0].key_hash).toBe(newKeyHash);

      // Verify change_log row recorded
      const logRes = await pool.query(
        "SELECT * FROM change_log WHERE entity = 'device' AND entity_id = $1 AND op = 'UPDATE'",
        [testDeviceId]
      );
      expect(logRes.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('filters devices by location_id and status on GET /api/devices', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/devices?location_id=${testLocationId}&status=online`,
        headers: authHeaders,
      });
      expect(res.statusCode).toBe(200);
      const devices = res.json().devices;
      expect(devices.length).toBeGreaterThanOrEqual(1);
      expect(devices[0].location_id).toBe(testLocationId);
    });
  });

  describe('3. Rule Management & Discriminated Zod Validation', () => {
    it('creates valid threshold rule via POST /api/rules', async () => {
      testRuleId = `test-rule-${testLocationId}-thresh`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        headers: authHeaders,
        payload: {
          id: testRuleId,
          name: 'High Heat Alert',
          type: 'threshold',
          rule_type: 'threshold',
          config: {
            field: 'temperature',
            operator: '>',
            value: 85,
          },
          scope: { type: 'all' },
          scope_type: 'all',
          severity: 'critical',
          enabled: true,
          cooldown: 60,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().rule.id).toBe(testRuleId);
    });

    it('creates valid absence rule via POST /api/rules', async () => {
      const absenceRuleId = `test-rule-${testLocationId}-abs`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        headers: authHeaders,
        payload: {
          id: absenceRuleId,
          name: 'Device Silence Alert',
          type: 'absence',
          rule_type: 'absence',
          config: {
            timeout_seconds: 120,
          },
          scope: { type: 'all' },
          scope_type: 'all',
          severity: 'warning',
          enabled: true,
          cooldown: 0,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().rule.id).toBe(absenceRuleId);
    });

    it('rejects invalid threshold rule config with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        headers: authHeaders,
        payload: {
          name: 'Broken Rule',
          type: 'threshold',
          rule_type: 'threshold',
          config: {
            field: 'temperature',
            operator: 'INVALID_OP', // invalid operator
            value: 85,
          },
          severity: 'critical',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Validation error');
    });

    it('rejects invalid absence rule config with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/rules',
        headers: authHeaders,
        payload: {
          name: 'Broken Absence',
          type: 'absence',
          rule_type: 'absence',
          config: {
            timeout_seconds: -10, // negative timeout
          },
          severity: 'warning',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Validation error');
    });

    it('updates rule config via PATCH /api/rules/:id and validates update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/rules/${testRuleId}`,
        headers: authHeaders,
        payload: {
          name: 'Updated Heat Alert',
          config: {
            field: 'temperature',
            operator: '>=',
            value: 90,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().rule.name).toBe('Updated Heat Alert');
      expect(res.json().rule.config.value).toBe(90);
    });

    it('deletes rule via DELETE /api/rules/:id and records change_log', async () => {
      const toDeleteId = `test-rule-${testLocationId}-del`;
      await pool.query(
        `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
         VALUES ($1, 'To Delete', 'threshold', 'threshold', '{"field":"x","operator":">","value":1}'::jsonb, '{"type":"all"}'::jsonb, 'all', 'low', true, 0)`,
        [toDeleteId]
      );

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/rules/${toDeleteId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBe(true);

      const check = await pool.query('SELECT * FROM rules WHERE id = $1', [toDeleteId]);
      expect(check.rows.length).toBe(0);

      const logRes = await pool.query(
        "SELECT * FROM change_log WHERE entity = 'rule' AND entity_id = $1 AND op = 'DELETE'",
        [toDeleteId]
      );
      expect(logRes.rows.length).toBe(1);
    });
  });

  describe('4. Incident State Machine (Ack / Resolve, Idempotency, Conflict 409)', () => {
    let incidentId: string;

    beforeAll(async () => {
      incidentId = randomUUID();
      await pool.query(
        `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary, occurrence_count)
         VALUES ($1, $2, $3, $4, 'open', 'critical', 'Test Engine Overheat', 1)`,
        [incidentId, `dedup-${incidentId}`, testRuleId, testDeviceId]
      );
    });

    it('transitions open -> acknowledged with POST /api/incidents/:id/ack and records actor', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/incidents/${incidentId}/ack`,
        headers: authHeaders,
        payload: {
          actor: 'operator:alice',
          reason: 'Alice investigating overheat',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('acknowledged');
      expect(res.json().actor).toBe('operator:alice');

      // Verify DB status
      const incRes = await pool.query<{ status: string; acknowledged_at: Date }>(
        'SELECT status, acknowledged_at FROM incidents WHERE id = $1',
        [incidentId]
      );
      expect(incRes.rows[0].status).toBe('acknowledged');
      expect(incRes.rows[0].acknowledged_at).not.toBeNull();

      // Verify incident_history
      const histRes = await pool.query(
        'SELECT * FROM incident_history WHERE incident_id = $1 AND to_status = $2',
        [incidentId, 'acknowledged']
      );
      expect(histRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(histRes.rows[0].actor).toBe('operator:alice');
      expect(histRes.rows[0].reason).toContain('Alice investigating overheat');
    });

    it('ack is idempotent: acknowledging an already acknowledged incident returns 200 idempotent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/incidents/${incidentId}/ack`,
        headers: authHeaders,
        payload: { actor: 'operator:bob' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().idempotent).toBe(true);
      expect(res.json().status).toBe('acknowledged');
    });

    it('transitions acknowledged -> resolved with POST /api/incidents/:id/resolve', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/incidents/${incidentId}/resolve`,
        headers: authHeaders,
        payload: {
          actor: 'operator:alice',
          reason: 'Replaced coolant pump',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('resolved');

      const incRes = await pool.query<{ status: string; resolved_at: Date }>(
        'SELECT status, resolved_at FROM incidents WHERE id = $1',
        [incidentId]
      );
      expect(incRes.rows[0].status).toBe('resolved');
      expect(incRes.rows[0].resolved_at).not.toBeNull();
    });

    it('resolve is idempotent: resolving an already resolved incident returns 200 idempotent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/incidents/${incidentId}/resolve`,
        headers: authHeaders,
        payload: { actor: 'operator:alice' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().idempotent).toBe(true);
      expect(res.json().status).toBe('resolved');
    });

    it('invalid transition: acknowledging a resolved incident returns 409 Conflict', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/incidents/${incidentId}/ack`,
        headers: authHeaders,
        payload: { actor: 'operator:charlie' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Cannot acknowledge incident in');
    });

    it('invalid transition: resolving an auto_resolved incident returns 409 Conflict', async () => {
      const autoResId = randomUUID();
      await pool.query(
        `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
         VALUES ($1, $2, $3, $4, 'auto_resolved', 'warning', 'Absence resolved')`,
        [autoResId, `dedup-${autoResId}`, testRuleId, testDeviceId]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/incidents/${autoResId}/resolve`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Cannot resolve incident in');
    });

    it('GET /api/incidents/:id returns full detail including history and evaluations', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/incidents/${incidentId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.incident).toBeDefined();
      expect(data.incident.id).toBe(incidentId);
      expect(Array.isArray(data.history)).toBe(true);
      expect(data.history.length).toBeGreaterThanOrEqual(2); // open->ack, ack->resolve
      expect(data.incident.notification_status).toBeDefined();
    });
  });

  describe('5. Events Cursor Pagination & Explainability', () => {
    const eventIds: string[] = [];

    beforeAll(async () => {
      // Insert 5 events spaced apart in time
      for (let i = 1; i <= 5; i++) {
        const evId = randomUUID();
        eventIds.push(evId);
        await pool.query(
          `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
           VALUES ($1, $2, $3, NOW(), NOW() - ($4 || ' seconds')::interval, 'telemetry', $5::jsonb, 'done')`,
          [evId, testDeviceId, 100 + i, `${(6 - i) * 10}`, JSON.stringify({ temp: 80 + i })]
        );
      }
    });

    it('paginates events with limit and cursor, without duplicates or skips', async () => {
      // Page 1: limit 2
      const page1Res = await app.inject({
        method: 'GET',
        url: `/api/events?device_id=${testDeviceId}&limit=2`,
        headers: authHeaders,
      });

      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json();
      expect(page1.events.length).toBe(2);
      expect(page1.has_more).toBe(true);
      expect(page1.next_cursor).toBeDefined();

      const page1Ids = page1.events.map((e: any) => e.event_id);

      // Page 2: limit 2 with cursor
      const page2Res = await app.inject({
        method: 'GET',
        url: `/api/events?device_id=${testDeviceId}&limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
        headers: authHeaders,
      });

      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json();
      expect(page2.events.length).toBe(2);

      const page2Ids = page2.events.map((e: any) => e.event_id);

      // Assert no overlap between page 1 and page 2
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it('GET /api/events/:id/explain returns evaluations and match reasons', async () => {
      const targetEventId = eventIds[0];
      await pool.query(
        `INSERT INTO rule_evaluations (event_id, rule_id, matched, reason)
         VALUES ($1, $2, true, 'temp (81) > 80 threshold matched')`,
        [targetEventId, testRuleId]
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/events/${targetEventId}/explain`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.event.event_id).toBe(targetEventId);
      expect(data.evaluations.length).toBeGreaterThanOrEqual(1);
      expect(data.evaluations[0].matched).toBe(true);
      expect(data.evaluations[0].reason).toContain('threshold matched');
      expect(data.evaluations[0].decision).toBeDefined();
      expect(data.evaluations[0].decision_explanation).toBeDefined();
      expect(data.explanation_summary).toBeDefined();
    });
  });

  describe('6. System Stats & Dead-Letter Requeue APIs', () => {
    it('GET /api/stats returns all platform operational metrics', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stats',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(stats.events_per_minute).toBeDefined();
      expect(stats.devices_by_status).toBeDefined();
      expect(stats.open_incidents_by_severity).toBeDefined();
      expect(stats.queue_depth_and_lag).toBeDefined();
      expect(stats.queue_depth_and_lag.pending_depth).toBeDefined();
      expect(stats.failed_events).toBeDefined();
      expect(stats.outbox_state).toBeDefined();
    });

    it('GET /api/dead-letters lists failed events and dead notifications', async () => {
      const failedEvId = randomUUID();
      await pool.query(
        `INSERT INTO events (event_id, device_id, seq, ts, type, processing_status, attempts, last_error)
         VALUES ($1, $2, 999, NOW(), 'telemetry', 'failed', 3, 'Fatal syntax error')`,
        [failedEvId, testDeviceId]
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/dead-letters',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.failed_events)).toBe(true);
      const found = data.failed_events.find((e: any) => e.event_id === failedEvId);
      expect(found).toBeDefined();
      expect(found.last_error).toBe('Fatal syntax error');

      // Requeue via POST /api/dead-letters/requeue
      const requeueRes = await app.inject({
        method: 'POST',
        url: '/api/dead-letters/requeue',
        headers: authHeaders,
        payload: { target: 'events' },
      });

      expect(requeueRes.statusCode).toBe(200);
      expect(requeueRes.json().requeued_events).toBeGreaterThanOrEqual(1);

      // Verify event is back to pending
      const check = await pool.query(
        'SELECT processing_status, attempts FROM events WHERE event_id = $1',
        [failedEvId]
      );
      expect(check.rows[0].processing_status).toBe('pending');
      expect(check.rows[0].attempts).toBe(0);

      await pool.query('DELETE FROM events WHERE event_id = $1', [failedEvId]);
    });
  });

  describe('7. SSE Real-Time Stream Replay & Resync Required Path', () => {
    it('replays missed items on reconnect without duplicates or gaps', async () => {
      // Insert two change_log rows
      const entityId1 = `test-sse-1-${randomUUID()}`;
      const entityId2 = `test-sse-2-${randomUUID()}`;

      const res1 = await pool.query<{ seq: string }>(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('test', $1, 'INSERT', '{"test":1}'::jsonb)
         RETURNING seq`,
        [entityId1]
      );
      const seq1 = Number(res1.rows[0].seq);

      const res2 = await pool.query<{ seq: string }>(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('test', $1, 'INSERT', '{"test":2}'::jsonb)
         RETURNING seq`,
        [entityId2]
      );
      const seq2 = Number(res2.rows[0].seq);

      // Connect with after_seq = seq1 - 1
      const res = await app.inject({
        method: 'GET',
        url: `/api/stream?after_seq=${seq1 - 1}&close_after_replay=true`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      const payload = res.payload;

      expect(payload).toContain(`id: ${seq1}`);
      expect(payload).toContain(`id: ${seq2}`);
      expect(payload).toContain(entityId1);
      expect(payload).toContain(entityId2);
    });

    it('signals resync_required if the gap is too large (> 500 events)', async () => {
      // Connect with after_seq = 0 when change_log has more than 500 events
      // Insert 501 dummy change_log entries if not already present
      const countRes = await pool.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM change_log'
      );
      const currentCount = Number(countRes.rows[0].count);

      if (currentCount < 505) {
        await pool.query(`
          INSERT INTO change_log (entity, entity_id, op, data)
          SELECT 'bulk_test', 'test-' || i, 'INSERT', '{"k":1}'::jsonb
          FROM generate_series(1, 510) s(i)
        `);
      }

      const res = await app.inject({
        method: 'GET',
        url: '/api/stream?after_seq=0',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      expect(res.payload).toContain('event: resync_required');
      expect(res.payload).toContain('Replay gap');
      expect(res.payload).toContain('exceeds maximum window of 500');
    });
  });
});
