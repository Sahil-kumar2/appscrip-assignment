import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { OutboxWorker } from '../outbox-worker.js';
import { QueueWorker } from '../queue-worker.js';
import { WorkerConfig } from '../config.js';

interface StoredNotif {
  id: string;
  idempotencyKey?: string;
  body: any;
  receivedAt: string;
}

describe('Notification Pipeline & Resilience (Real PostgreSQL & Sink)', () => {
  const connectionString =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString });

  const workerConfig: WorkerConfig = {
    DATABASE_URL: connectionString,
    WORKER_POLL_INTERVAL_MS: 500,
    WORKER_BATCH_SIZE: 10,
    EVENT_LEASE_SECONDS: 10,
    MAX_EVENT_ATTEMPTS: 3,
    OUTBOX_POLL_INTERVAL_MS: 500,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_TIMEOUT_MS: 1500,
    MAX_OUTBOX_ATTEMPTS: 3,
    ABSENCE_CHECK_INTERVAL_MS: 5000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 800,
    LOG_LEVEL: 'silent',
  };

  let httpServer: http.Server;
  let sinkPort: number;
  let sinkUrl: string;

  const storedNotifications: StoredNotif[] = [];
  const idempotencyMap = new Map<string, StoredNotif>();
  let sinkMode: 'ok' | 'fail' | 'slow' = 'ok';

  let outboxWorker: OutboxWorker;
  let queueWorker: QueueWorker;

  const testLocationId = 'loc-notif-pipe-test';
  const testOperatorId = 'op-notif-pipe-test';
  const testDeviceId = 'dev-notif-pipe-test';
  const testRuleId = 'rule-notif-pipe-test';

  beforeAll(async () => {
    // 1. Start notification sink on dynamic port
    httpServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const url = req.url || '/';

        if (req.method === 'POST' && url === '/admin/mode') {
          const body = JSON.parse(raw || '{}');
          sinkMode = body.mode || 'ok';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', mode: sinkMode }));
          return;
        }

        if (req.method === 'GET' && url === '/received') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              total: storedNotifications.length,
              notifications: storedNotifications,
            })
          );
          return;
        }

        if (req.method === 'DELETE' && url === '/received') {
          storedNotifications.length = 0;
          idempotencyMap.clear();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'cleared' }));
          return;
        }

        if (sinkMode === 'fail') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'HTTP Error 503: Service Unavailable' }));
          return;
        }

        const rawKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
        const idemKey = typeof rawKey === 'string' ? rawKey.trim() : undefined;

        if (idemKey && idempotencyMap.has(idemKey)) {
          const existing = idempotencyMap.get(idemKey)!;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', duplicate: true, received_id: existing.id }));
          return;
        }

        const item: StoredNotif = {
          id: `sink-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          idempotencyKey: idemKey,
          body: JSON.parse(raw || '{}'),
          receivedAt: new Date().toISOString(),
        };
        storedNotifications.unshift(item);
        if (idemKey) {
          idempotencyMap.set(idemKey, item);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', duplicate: false, received_id: item.id }));
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        sinkPort = (httpServer.address() as AddressInfo).port;
        sinkUrl = `http://127.0.0.1:${sinkPort}/webhook`;
        resolve();
      });
    });

    // 2. Setup workers
    outboxWorker = new OutboxWorker(pool, workerConfig);
    queueWorker = new QueueWorker(pool, workerConfig);

    // 3. Seed test location, operator, device, rule
    await pool.query(
      `INSERT INTO locations (id, name) VALUES ($1, 'Notification Test Lab')
       ON CONFLICT (id) DO NOTHING`,
      [testLocationId]
    );

    await pool.query(
      `INSERT INTO operators (id, name, webhook_url, location_ids)
       VALUES ($1, 'On-Call Operator', $2, $3)
       ON CONFLICT (id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, location_ids = EXCLUDED.location_ids`,
      [testOperatorId, sinkUrl, [testLocationId]]
    );

    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status, last_seq, last_seen_at)
       VALUES ($1, 'Pipe Device', $2, 'fake-hash', 'online', 0, NOW())
       ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, status = 'online'`,
      [testDeviceId, testLocationId]
    );

    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'Pipe High Temp Alert', 'threshold', 'threshold',
               '{"field":"temperature","operator":">","value":85}'::jsonb,
               $2::jsonb, 'device', 'critical', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, scope = EXCLUDED.scope, enabled = true`,
      [testRuleId, JSON.stringify({ type: 'device', value: testDeviceId })]
    );

    // Clean previous artifacts
    await pool.query(
      'DELETE FROM incident_events WHERE event_id IN (SELECT event_id FROM events WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM rule_evaluations WHERE event_id IN (SELECT event_id FROM events WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM notification_outbox WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM incident_history WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query('DELETE FROM incidents WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM events WHERE device_id = $1', [testDeviceId]);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query(
      'DELETE FROM incident_events WHERE event_id IN (SELECT event_id FROM events WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM rule_evaluations WHERE event_id IN (SELECT event_id FROM events WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM notification_outbox WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query(
      'DELETE FROM incident_history WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query('DELETE FROM incidents WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM events WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM rules WHERE id = $1', [testRuleId]);
    await pool.query('DELETE FROM devices WHERE id = $1', [testDeviceId]);
    await pool.query('DELETE FROM operators WHERE id = $1', [testOperatorId]);
    await pool.query('DELETE FROM locations WHERE id = $1', [testLocationId]);

    httpServer.close();
    await pool.end();
  });

  it('success path: delivers notification with Idempotency-Key header, updates outbox to sent, and stores in sink', async () => {
    // 1. Reset sink to mode ok and clear received
    sinkMode = 'ok';
    storedNotifications.length = 0;
    idempotencyMap.clear();

    const incidentId = randomUUID();
    const notificationId = randomUUID();

    // Create test incident
    await pool.query(
      `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
       VALUES ($1, $2, $3, $4, 'open', 'critical', 'Test summary')`,
      [incidentId, `dedup-${incidentId}`, testRuleId, testDeviceId]
    );

    // Create pending outbox notification
    await pool.query(
      `INSERT INTO notification_outbox (id, incident_id, operator_id, destination_url, payload, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, NOW())`,
      [
        notificationId,
        incidentId,
        testOperatorId,
        sinkUrl,
        JSON.stringify({
          incident_id: incidentId,
          rule_name: 'Pipe Alert',
          device_id: testDeviceId,
        }),
      ]
    );

    // 2. Outbox worker processes batch
    const processed = await outboxWorker.processBatch();
    expect(processed).toBeGreaterThanOrEqual(1);

    // 3. Verify outbox row transitioned to 'sent'
    const outboxCheck = await pool.query(
      'SELECT status, last_error FROM notification_outbox WHERE id = $1',
      [notificationId]
    );
    expect(outboxCheck.rows[0].status).toBe('sent');
    expect(outboxCheck.rows[0].last_error).toBeNull();

    // 4. Verify sink received the notification with matching idempotency key
    expect(storedNotifications).toHaveLength(1);
    expect(storedNotifications[0].idempotencyKey).toBe(notificationId);
    expect(storedNotifications[0].body.incident_id).toBe(incidentId);
  });

  it('sink down then recovers: all notifications eventually delivered exactly once from sink view via idempotency key', async () => {
    // 1. Set sink to outage mode (fail) and clear sink
    sinkMode = 'fail';
    storedNotifications.length = 0;
    idempotencyMap.clear();

    const incidentId = randomUUID();
    const notificationId = randomUUID();

    await pool.query(
      `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
       VALUES ($1, $2, $3, $4, 'open', 'warning', 'Recover test')`,
      [incidentId, `dedup-${incidentId}`, testRuleId, testDeviceId]
    );

    await pool.query(
      `INSERT INTO notification_outbox (id, incident_id, operator_id, destination_url, payload, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, NOW())`,
      [
        notificationId,
        incidentId,
        testOperatorId,
        sinkUrl,
        JSON.stringify({ incident_id: incidentId, note: 'delivery-retry-test' }),
      ]
    );

    // 2. Outbox worker attempts delivery -> fails
    await outboxWorker.processBatch();

    // Outbox status should be 'failed' with attempts = 1
    const failedCheck = await pool.query(
      'SELECT status, attempts, last_error FROM notification_outbox WHERE id = $1',
      [notificationId]
    );
    expect(failedCheck.rows[0].status).toBe('failed');
    expect(failedCheck.rows[0].attempts).toBe(1);
    expect(failedCheck.rows[0].last_error).toContain('HTTP Error 503');

    // Sink received nothing while in fail mode
    expect(storedNotifications).toHaveLength(0);

    // 3. Sink recovers! Set mode back to "ok"
    sinkMode = 'ok';

    // Reset next_attempt_at to NOW() so worker can pick it up immediately
    await pool.query('UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = $1', [
      notificationId,
    ]);

    // 4. Outbox worker retries delivery
    await outboxWorker.processBatch();

    // Outbox status is now 'sent'
    const successCheck = await pool.query(
      'SELECT status, attempts FROM notification_outbox WHERE id = $1',
      [notificationId]
    );
    expect(successCheck.rows[0].status).toBe('sent');

    // 5. From the sink's view via Idempotency-Key: delivered and stored EXACTLY ONCE
    expect(storedNotifications).toHaveLength(1);
    expect(storedNotifications[0].idempotencyKey).toBe(notificationId);

    // Redelivery attempt with the same idempotency key is acknowledged as duplicate
    const redeliverRes = await fetch(sinkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': notificationId },
      body: JSON.stringify({ incident_id: incidentId }),
    });
    const redeliverJson = (await redeliverRes.json()) as { duplicate: boolean };
    expect(redeliverJson.duplicate).toBe(true);

    // Sink still has exactly 1 notification
    expect(storedNotifications).toHaveLength(1);
  });

  it('circuit breaker opens on consecutive failures and closes after recovery', async () => {
    // 1. Set sink to fail
    sinkMode = 'fail';

    const cb = outboxWorker.getCircuitBreaker(sinkUrl);

    // Trigger consecutive failures (threshold is 2)
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');

    // Insert new notification
    const notifId = randomUUID();
    const incId = randomUUID();
    await pool.query(
      `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
       VALUES ($1, $2, $3, $4, 'open', 'warning', 'CB Test')`,
      [incId, `dedup-${incId}`, testRuleId, testDeviceId]
    );
    await pool.query(
      `INSERT INTO notification_outbox (id, incident_id, operator_id, destination_url, payload, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 'pending', 0, NOW())`,
      [notifId, incId, testOperatorId, sinkUrl]
    );

    // Process batch while circuit is OPEN: should postpone without HTTP request
    await outboxWorker.processBatch();

    const cbCheck = await pool.query(
      'SELECT status, last_error FROM notification_outbox WHERE id = $1',
      [notifId]
    );
    expect(cbCheck.rows[0].status).toBe('failed');
    expect(cbCheck.rows[0].last_error).toContain('CircuitBreaker is OPEN');

    // 2. Sink recovers and reset timeout expires
    sinkMode = 'ok';

    // Wait for circuit breaker reset timeout (800ms)
    await new Promise((resolve) => setTimeout(resolve, 850));

    // Next request triggers HALF_OPEN probe and closes circuit on success
    await pool.query('UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = $1', [
      notifId,
    ]);
    await outboxWorker.processBatch();

    // Circuit breaker closed, notification sent
    expect(cb.getState()).toBe('CLOSED');
    const sentCheck = await pool.query('SELECT status FROM notification_outbox WHERE id = $1', [
      notifId,
    ]);
    expect(sentCheck.rows[0].status).toBe('sent');
  });

  it('process restart mid-send does not lose notifications', async () => {
    sinkMode = 'ok';

    const notifId = randomUUID();
    const incId = randomUUID();
    await pool.query(
      `INSERT INTO incidents (id, dedup_key, rule_id, device_id, status, severity, summary)
       VALUES ($1, $2, $3, $4, 'open', 'warning', 'Restart Test')`,
      [incId, `dedup-${incId}`, testRuleId, testDeviceId]
    );

    // Simulate notification being claimed and left in_flight due to worker crash
    await pool.query(
      `INSERT INTO notification_outbox (id, incident_id, operator_id, destination_url, payload, status, attempts, next_attempt_at, updated_at)
       VALUES ($1, $2, $3, $4, '{"restart":true}'::jsonb, 'in_flight', 0, NOW(), NOW() - INTERVAL '1 minute')`,
      [notifId, incId, testOperatorId, sinkUrl]
    );

    // A new worker instance boots up (simulating restart)
    const newWorker = new OutboxWorker(pool, workerConfig);
    const reclaimedCount = await newWorker.reclaimInFlight();
    expect(reclaimedCount).toBeGreaterThanOrEqual(1);

    // Status is restored to 'pending'
    const statusCheck = await pool.query('SELECT status FROM notification_outbox WHERE id = $1', [
      notifId,
    ]);
    expect(statusCheck.rows[0].status).toBe('pending');

    // Worker delivers the reclaimed notification
    await newWorker.processBatch();
    const deliveredCheck = await pool.query(
      'SELECT status FROM notification_outbox WHERE id = $1',
      [notifId]
    );
    expect(deliveredCheck.rows[0].status).toBe('sent');
  });

  it('incident creation succeeds while the sink is down (transactional outbox isolation)', async () => {
    // Clean previous incidents for this device to isolate this test
    await pool.query(
      'DELETE FROM notification_outbox WHERE incident_id IN (SELECT id FROM incidents WHERE device_id = $1)',
      [testDeviceId]
    );
    await pool.query('DELETE FROM incidents WHERE device_id = $1', [testDeviceId]);

    // 1. Sink is completely down
    sinkMode = 'fail';

    const eventId = randomUUID();
    // 2. High temperature event triggers rule match
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
       VALUES ($1, $2, 999, NOW(), NOW(), 'telemetry', '{"temperature": 96}'::jsonb, 'pending')`,
      [eventId, testDeviceId]
    );

    // Process event in QueueWorker
    await queueWorker.processBatch();

    // 3. Event is marked done
    const ev = await pool.query('SELECT processing_status FROM events WHERE event_id = $1', [
      eventId,
    ]);
    expect(ev.rows[0].processing_status).toBe('done');

    // 4. Incident was successfully created in the same transaction despite sink failure!
    const incRes = await pool.query(
      "SELECT id, status, occurrence_count FROM incidents WHERE device_id = $1 AND rule_id = $2 AND status = 'open'",
      [testDeviceId, testRuleId]
    );
    expect(incRes.rows.length).toBeGreaterThanOrEqual(1);

    // 5. Transactional outbox row was safely committed with status 'pending'
    const outboxRes = await pool.query(
      'SELECT id, status FROM notification_outbox WHERE incident_id = $1',
      [incRes.rows[0].id]
    );
    expect(outboxRes.rows.length).toBeGreaterThanOrEqual(1);
    expect(outboxRes.rows[0].status).toBe('pending');
  });
});
