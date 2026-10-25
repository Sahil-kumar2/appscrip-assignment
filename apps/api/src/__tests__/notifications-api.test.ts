import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../server.js';
import { loadApiConfig } from '../config.js';

describe('Notifications & Incident Notification Status API (Real PostgreSQL)', () => {
  const connectionString =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString });

  const apiConfig = loadApiConfig({
    DATABASE_URL: connectionString,
    LOG_LEVEL: 'silent',
  });
  const app = buildServer(apiConfig, pool);

  const testLocationId = 'loc-notif-api-test';
  const testOperatorId = 'op-notif-api-test';
  const testDeviceId = 'dev-notif-api-test';
  const testRuleId = 'rule-notif-api-test';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO locations (id, name) VALUES ($1, 'API Notif Lab')
       ON CONFLICT (id) DO NOTHING`,
      [testLocationId]
    );

    await pool.query(
      `INSERT INTO operators (id, name, webhook_url, location_ids)
       VALUES ($1, 'API Notif Operator', 'http://127.0.0.1:4000/webhook', $2)
       ON CONFLICT (id) DO UPDATE SET location_ids = EXCLUDED.location_ids`,
      [testOperatorId, [testLocationId]]
    );

    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status)
       VALUES ($1, 'API Device', $2, 'fake-hash', 'online')
       ON CONFLICT (id) DO NOTHING`,
      [testDeviceId, testLocationId]
    );

    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'API Rule', 'threshold', 'threshold', '{}'::jsonb, '{"type":"all"}'::jsonb, 'all', 'critical', true, 0)
       ON CONFLICT (id) DO NOTHING`,
      [testRuleId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM notification_outbox WHERE operator_id = $1', [testOperatorId]);
    await pool.query('DELETE FROM incidents WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM devices WHERE id = $1', [testDeviceId]);
    await pool.query('DELETE FROM rules WHERE id = $1', [testRuleId]);
    await pool.query('DELETE FROM operators WHERE id = $1', [testOperatorId]);
    await pool.query('DELETE FROM locations WHERE id = $1', [testLocationId]);
    await pool.end();
  });

  it('exposes notification_status (pending/sent/failed/dead) on incidents in GET /api/incidents and GET /api/incidents/:id', async () => {
    const incId = randomUUID();
    const notifId = randomUUID();

    await pool.query(
      `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
       VALUES ($1, $2, $3, $4, 'open', 'critical', 'API Test Summary')`,
      [incId, `dedup-${incId}`, testRuleId, testDeviceId]
    );

    await pool.query(
      `INSERT INTO notification_outbox (id, incident_id, operator_id, destination_url, payload, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, 'http://127.0.0.1:4000/webhook', '{}'::jsonb, 'pending', 0, NOW())`,
      [notifId, incId, testOperatorId]
    );

    // 1. Initially 'pending'
    const resPending = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incId}`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(resPending.statusCode).toBe(200);
    expect(resPending.json().incident.notification_status).toBe('pending');
    expect(resPending.json().notifications).toHaveLength(1);

    // Also check in GET /api/incidents list
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/incidents?device_id=${testDeviceId}`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(listRes.statusCode).toBe(200);
    const incInList = listRes.json().incidents.find((i: any) => i.id === incId);
    expect(incInList).toBeDefined();
    expect(incInList.notification_status).toBe('pending');

    // 2. Transition to 'sent'
    await pool.query("UPDATE notification_outbox SET status = 'sent' WHERE id = $1", [notifId]);
    const resSent = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incId}`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(resSent.json().incident.notification_status).toBe('sent');

    // 3. Transition to 'failed'
    await pool.query("UPDATE notification_outbox SET status = 'failed' WHERE id = $1", [notifId]);
    const resFailed = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incId}`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(resFailed.json().incident.notification_status).toBe('failed');

    // 4. Transition to 'dead'
    await pool.query("UPDATE notification_outbox SET status = 'dead' WHERE id = $1", [notifId]);
    const resDead = await app.inject({
      method: 'GET',
      url: `/api/incidents/${incId}`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(resDead.json().incident.notification_status).toBe('dead');
  });

  it('retries dead notifications via POST /api/notifications/:id/retry, POST /api/notifications/retry-dead, and POST /api/incidents/:id/retry-notifications', async () => {
    const incId = randomUUID();
    const notifId1 = randomUUID();
    const notifId2 = randomUUID();

    await pool.query(
      `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
       VALUES ($1, $2, $3, $4, 'open', 'critical', 'Retry Test Summary')`,
      [incId, `dedup-${incId}`, testRuleId, testDeviceId]
    );

    await pool.query(
      `INSERT INTO notification_outbox (id, incident_id, operator_id, destination_url, payload, status, attempts, next_attempt_at, last_error)
       VALUES 
       ($1, $2, $3, 'http://127.0.0.1:4000/webhook', '{}'::jsonb, 'dead', 3, NOW() - INTERVAL '1 hour', 'Fatal 500'),
       ($4, $2, $3, 'http://127.0.0.1:4000/webhook', '{}'::jsonb, 'dead', 3, NOW() - INTERVAL '1 hour', 'Fatal 503')`,
      [notifId1, incId, testOperatorId, notifId2]
    );

    // 1. Retry specific notification by ID
    const retrySingle = await app.inject({
      method: 'POST',
      url: `/api/notifications/${notifId1}/retry`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(retrySingle.statusCode).toBe(200);
    expect(retrySingle.json().success).toBe(true);

    const check1 = await pool.query(
      'SELECT status, attempts FROM notification_outbox WHERE id = $1',
      [notifId1]
    );
    expect(check1.rows[0].status).toBe('pending');
    expect(check1.rows[0].attempts).toBe(0);

    // 2. Retry dead notifications for incident: POST /api/incidents/:id/retry-notifications
    const retryInc = await app.inject({
      method: 'POST',
      url: `/api/incidents/${incId}/retry-notifications`,
      headers: { authorization: 'Bearer operator-secret-token' },
    });
    expect(retryInc.statusCode).toBe(200);
    expect(retryInc.json().retried_count).toBeGreaterThanOrEqual(1);

    const check2 = await pool.query(
      'SELECT status, attempts FROM notification_outbox WHERE id = $1',
      [notifId2]
    );
    expect(check2.rows[0].status).toBe('pending');
    expect(check2.rows[0].attempts).toBe(0);

    // 3. Bulk retry dead notifications: POST /api/notifications/retry-dead
    await pool.query("UPDATE notification_outbox SET status = 'dead' WHERE id IN ($1, $2)", [
      notifId1,
      notifId2,
    ]);
    const bulkRetry = await app.inject({
      method: 'POST',
      url: '/api/notifications/retry-dead',
      headers: { authorization: 'Bearer operator-secret-token' },
      payload: { incident_id: incId },
    });
    expect(bulkRetry.statusCode).toBe(200);
    expect(bulkRetry.json().retried_count).toBe(2);
  });
});
