import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { buildServer } from '../apps/api/src/server.js';
import { loadApiConfig } from '../apps/api/src/config.js';
import { QueueWorker } from '../apps/worker/src/queue-worker.js';
import { OutboxWorker } from '../apps/worker/src/outbox-worker.js';
import { AbsenceMonitor } from '../apps/worker/src/absence-monitor.js';
import { WorkerConfig } from '../apps/worker/src/config.js';
import { hashDeviceKey } from '@aps/shared';

describe('Assignment Failure Scenarios & Invariant Verification (Real PostgreSQL)', () => {
  const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString: dbUrl });

  const OPERATOR_TOKEN = 'test-operator-bearer-token';
  const apiConfig = loadApiConfig({
    DATABASE_URL: dbUrl,
    OPERATOR_TOKEN,
    LOG_LEVEL: 'silent',
    QUEUE_BACKPRESSURE_THRESHOLD: '100',
  });
  const app = buildServer(apiConfig, pool);

  const workerConfig: WorkerConfig = {
    DATABASE_URL: dbUrl,
    WORKER_POLL_INTERVAL_MS: 200,
    WORKER_BATCH_SIZE: 20,
    EVENT_LEASE_SECONDS: 2, // short lease for fast restart/reclaim test
    MAX_EVENT_ATTEMPTS: 3,
    OUTBOX_POLL_INTERVAL_MS: 200,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_TIMEOUT_MS: 1500,
    MAX_OUTBOX_ATTEMPTS: 3,
    ABSENCE_CHECK_INTERVAL_MS: 1000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 500,
    LOG_LEVEL: 'silent',
  };

  const queueWorker = new QueueWorker(pool, workerConfig);
  const outboxWorker = new OutboxWorker(pool, workerConfig);
  const absenceMonitor = new AbsenceMonitor(pool, workerConfig);

  // Local sink server for testing outbox down-then-up
  let sinkServer: http.Server;
  let sinkPort: number;
  let sinkUrl: string;
  let sinkMode: 'ok' | 'fail' = 'ok';
  const sinkReceived: Array<{
    idempotencyKey?: string;
    body: any;
  }> = [];

  const testLocationId = 'loc-fail-test';
  const testOperatorId = 'op-fail-test';

  beforeAll(async () => {
    // Stop background containers if running so they do not race on test queues
    try {
      execSync('docker compose stop worker simulator', { stdio: 'ignore' });
    } catch {
      // Ignore if docker compose is not running locally
    }

    // Start local sink server
    sinkServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (sinkMode === 'fail') {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable' }));
          return;
        }

        const body = raw ? JSON.parse(raw) : {};
        const idempotencyKey = req.headers['idempotency-key'] as string;

        sinkReceived.push({ idempotencyKey, body });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'received', idempotencyKey }));
      });
    });

    await new Promise<void>((resolve) => {
      sinkServer.listen(0, '127.0.0.1', () => {
        sinkPort = (sinkServer.address() as AddressInfo).port;
        sinkUrl = `http://127.0.0.1:${sinkPort}/webhook`;
        resolve();
      });
    });

    // Seed location and operator
    await pool.query(
      `INSERT INTO locations (id, name) VALUES ($1, 'Failure Test Lab')
       ON CONFLICT (id) DO NOTHING`,
      [testLocationId]
    );

    await pool.query(
      `INSERT INTO operators (id, name, email, webhook_url, location_id)
       VALUES ($1, 'Failure Operator', 'op@test.com', $2, $3)
       ON CONFLICT (id) DO UPDATE SET webhook_url = EXCLUDED.webhook_url, location_id = EXCLUDED.location_id`,
      [testOperatorId, sinkUrl, testLocationId]
    );
  });

  afterAll(async () => {
    // Cleanup failure test records
    await pool.query(
      `DELETE FROM incident_history WHERE incident_id IN (
         SELECT id FROM incidents WHERE device_id LIKE 'dev-fail-%'
       )`
    );
    await pool.query(
      `DELETE FROM incident_events WHERE incident_id IN (
         SELECT id FROM incidents WHERE device_id LIKE 'dev-fail-%'
       )`
    );
    await pool.query(
      `DELETE FROM notification_outbox WHERE incident_id IN (
         SELECT id FROM incidents WHERE device_id LIKE 'dev-fail-%'
       )`
    );
    await pool.query("DELETE FROM incidents WHERE device_id LIKE 'dev-fail-%'");
    await pool.query("DELETE FROM events WHERE device_id LIKE 'dev-fail-%'");
    await pool.query("DELETE FROM rejected_events WHERE device_id LIKE 'dev-fail-%'");
    await pool.query("DELETE FROM rules WHERE id LIKE 'rule-fail-%'");
    await pool.query("DELETE FROM devices WHERE id LIKE 'dev-fail-%'");
    await pool.query('DELETE FROM operators WHERE id = $1', [testOperatorId]);
    await pool.query('DELETE FROM locations WHERE id = $1', [testLocationId]);

    await app.close();
    await pool.end();
    await new Promise<void>((resolve) => sinkServer.close(() => resolve()));

    // Restart docker background containers if compose is present
    try {
      execSync('docker compose start worker simulator', { stdio: 'ignore' });
    } catch {
      // Ignore
    }
  });

  // Helper to register a test device
  async function setupDevice(deviceId: string, rawKey: string) {
    const keyHash = hashDeviceKey(rawKey);
    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status, last_seq, last_seen_at)
       VALUES ($1, $2, $3, $4, 'online', 0, NOW())
       ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, last_seen_at = NOW()`,
      [deviceId, `Device ${deviceId}`, testLocationId, keyHash]
    );
  }

  // ---------------------------------------------------------------------------------------
  // Scenario 1: duplicate delivery
  // Invariant: no lost events, no duplicate incidents, bounded incident count
  // ---------------------------------------------------------------------------------------
  it('Scenario 1: duplicate delivery (no lost events, no duplicate incidents, bounded incident count)', async () => {
    const deviceId = 'dev-fail-dup-1';
    const rawKey = 'key-fail-dup-1';
    const ruleId = 'rule-fail-dup-1';
    await setupDevice(deviceId, rawKey);

    // Rule: temp > 50
    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'High Temp Dup Rule', 'threshold', 'threshold',
               '{"field":"temperature","operator":">","value":50}'::jsonb,
               '{"type":"device","value":"dev-fail-dup-1"}'::jsonb, 'device', 'critical', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [ruleId]
    );
    queueWorker.invalidateRuleCache();

    const eventId = randomUUID();
    const eventPayload = {
      event_id: eventId,
      device_id: deviceId,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { temperature: 85 },
      schema_version: 1,
    };

    // 1. First delivery -> accepted
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: [eventPayload],
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().results[0].status).toBe('accepted');

    // 2. Duplicate delivery -> duplicate acknowledged
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: [eventPayload],
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().results[0].status).toBe('duplicate');

    // 3. Batch delivery containing the duplicate and a new event
    const secondEventId = randomUUID();
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: [
        eventPayload, // duplicate
        {
          ...eventPayload,
          event_id: secondEventId,
          seq: 2,
          payload: { temperature: 88 },
        },
      ],
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.json().results[0].status).toBe('duplicate');
    expect(res3.json().results[1].status).toBe('accepted');

    // Invariant: events table must contain EXACTLY 1 row for eventId (no duplicates stored)
    const eventRows = await pool.query(
      'SELECT event_id, processing_status FROM events WHERE event_id = $1',
      [eventId]
    );
    expect(eventRows.rowCount).toBe(1);

    // Process both accepted events with QueueWorker
    await queueWorker.processBatch();

    // Invariant: no duplicate incidents! Exactly 1 incident created for ruleId:deviceId
    const incidentRows = await pool.query(
      'SELECT id, occurrence_count, status FROM incidents WHERE rule_id = $1 AND device_id = $2',
      [ruleId, deviceId]
    );
    expect(incidentRows.rowCount).toBe(1);
    // Invariant: bounded incident count (bumping occurrence count for the 2 accepted matching events)
    expect(incidentRows.rows[0].occurrence_count).toBe(2);

    // Invariant: no lost events (both accepted events are marked done)
    const allEvents = await pool.query(
      'SELECT processing_status FROM events WHERE device_id = $1',
      [deviceId]
    );
    expect(allEvents.rowCount).toBe(2);
    expect(allEvents.rows.every((r) => r.processing_status === 'done')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 2: accepted-but-processing-fails
  // Invariant: no lost events, attempts tracked, exponential backoff, dead-letter, and requeue
  // ---------------------------------------------------------------------------------------
  it('Scenario 2: accepted-but-processing-fails (no lost events, backoff, dead-letter, requeue API)', async () => {
    const deviceId = 'dev-fail-poison-2';
    const rawKey = 'key-fail-poison-2';
    await setupDevice(deviceId, rawKey);

    const poisonEventId = randomUUID();
    // Ingest event directly into queue
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, schema_version, processing_status, attempts)
       VALUES ($1, $2, 1, NOW(), NOW(), 'poison.test', '{"fail":true}'::jsonb, 1, 'pending', 0)`,
      [poisonEventId, deviceId]
    );

    // Create a worker instance with failing pool connection to induce a transient processing error
    const failingPool = {
      ...pool,
      connect: async () => {
        throw new Error('Simulated transient DB lock failure');
      },
      query: pool.query.bind(pool),
    } as any;

    const failingWorker = new QueueWorker(failingPool, {
      ...workerConfig,
      MAX_EVENT_ATTEMPTS: 3,
    });

    // Attempt 1
    await failingWorker.processSingleEvent({
      event_id: poisonEventId,
      device_id: deviceId,
      seq: 1,
      ts: new Date(),
      received_at: new Date(),
      type: 'poison.test',
      payload: { fail: true },
      attempts: 0,
    });

    let row = (
      await pool.query(
        'SELECT processing_status, attempts, locked_until, last_error FROM events WHERE event_id = $1',
        [poisonEventId]
      )
    ).rows[0];
    // Invariant: no lost events; status is pending with backoff and error recorded
    expect(row.processing_status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('Simulated transient DB lock failure');
    expect(new Date(row.locked_until).getTime()).toBeGreaterThan(Date.now());

    // Attempt 2
    await failingWorker.processSingleEvent({
      event_id: poisonEventId,
      device_id: deviceId,
      seq: 1,
      ts: new Date(),
      received_at: new Date(),
      type: 'poison.test',
      payload: { fail: true },
      attempts: 1,
    });

    row = (
      await pool.query(
        'SELECT processing_status, attempts, locked_until FROM events WHERE event_id = $1',
        [poisonEventId]
      )
    ).rows[0];
    expect(row.processing_status).toBe('pending');
    expect(row.attempts).toBe(2);

    // Attempt 3 -> exceeds MAX_EVENT_ATTEMPTS (3) -> moves to dead-letter ('failed')
    await failingWorker.processSingleEvent({
      event_id: poisonEventId,
      device_id: deviceId,
      seq: 1,
      ts: new Date(),
      received_at: new Date(),
      type: 'poison.test',
      payload: { fail: true },
      attempts: 2,
    });

    row = (
      await pool.query(
        'SELECT processing_status, attempts, last_error FROM events WHERE event_id = $1',
        [poisonEventId]
      )
    ).rows[0];
    // Invariant: event safely stored in dead-letter state
    expect(row.processing_status).toBe('failed');
    expect(row.attempts).toBe(3);

    // Invariant: No false incidents created for poison event
    const incRes = await pool.query('SELECT * FROM incidents WHERE device_id = $1', [deviceId]);
    expect(incRes.rowCount).toBe(0);

    // Test Operator API Requeue Hook
    const deadLettersRes = await app.inject({
      method: 'GET',
      url: '/api/dead-letters',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(deadLettersRes.statusCode).toBe(200);
    const failedEvents = deadLettersRes.json().failed_events;
    expect(failedEvents.some((dl: any) => dl.event_id === poisonEventId)).toBe(true);

    // Requeue the event
    const requeueRes = await app.inject({
      method: 'POST',
      url: '/api/dead-letters/requeue',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      payload: { type: 'events', id: poisonEventId },
    });
    expect(requeueRes.statusCode).toBe(200);
    expect(requeueRes.json().requeued_events).toBe(1);

    // Invariant: event reset to pending with attempts = 0
    const requeuedRow = (
      await pool.query(
        'SELECT processing_status, attempts, locked_until, last_error FROM events WHERE event_id = $1',
        [poisonEventId]
      )
    ).rows[0];
    expect(requeuedRow.processing_status).toBe('pending');
    expect(requeuedRow.attempts).toBe(0);
    expect(requeuedRow.locked_until).toBeNull();
    expect(requeuedRow.last_error).toBeNull();
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 3: worker restart mid-processing
  // Invariant: lease expiration reclaim, no lost events, no duplicate incidents, no lost notifications
  // ---------------------------------------------------------------------------------------
  it('Scenario 3: worker restart mid-processing (lease expiration reclaim, no lost events, no duplicate incidents)', async () => {
    const deviceId = 'dev-fail-reclaim-3';
    const rawKey = 'key-fail-reclaim-3';
    const ruleId = 'rule-fail-reclaim-3';
    await setupDevice(deviceId, rawKey);

    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'Reclaim Temp Rule', 'threshold', 'threshold',
               '{"field":"temperature","operator":">","value":40}'::jsonb,
               '{"type":"device","value":"dev-fail-reclaim-3"}'::jsonb, 'device', 'warning', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [ruleId]
    );
    queueWorker.invalidateRuleCache();

    const eventId = randomUUID();
    // Simulate Worker 1 claiming the event and crashing before completion
    // Status is 'processing', and lease has expired in the past
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, schema_version, processing_status, locked_until, attempts)
       VALUES ($1, $2, 1, NOW(), NOW(), 'telemetry', '{"temperature": 65}'::jsonb, 1, 'processing', NOW() - INTERVAL '5 seconds', 0)`,
      [eventId, deviceId]
    );

    // Invariant check mid-restart: event is still in Postgres
    const midRestartEvent = await pool.query(
      'SELECT processing_status, locked_until FROM events WHERE event_id = $1',
      [eventId]
    );
    expect(midRestartEvent.rows[0].processing_status).toBe('processing');

    // Worker 2 (restarted worker) runs claim and process batch
    const processedCount = await queueWorker.processBatch();
    expect(processedCount).toBeGreaterThanOrEqual(1);

    // Invariant: reclaimed event transitioned safely to 'done'
    const completedEvent = (
      await pool.query('SELECT processing_status, locked_until FROM events WHERE event_id = $1', [
        eventId,
      ])
    ).rows[0];
    expect(completedEvent.processing_status).toBe('done');
    expect(completedEvent.locked_until).toBeNull();

    // Invariant: exactly 1 incident created
    const incRes = await pool.query(
      'SELECT id, occurrence_count FROM incidents WHERE rule_id = $1 AND device_id = $2',
      [ruleId, deviceId]
    );
    expect(incRes.rowCount).toBe(1);
    expect(incRes.rows[0].occurrence_count).toBe(1);

    // Invariant: no lost notifications
    const outboxRes = await pool.query(
      'SELECT id, status FROM notification_outbox WHERE incident_id = $1',
      [incRes.rows[0].id]
    );
    expect(outboxRes.rowCount).toBe(1);
    expect(outboxRes.rows[0].status).toBe('pending');
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 4: notification service down then up
  // Invariant: no lost notifications, circuit breaker protection, idempotent delivery
  // ---------------------------------------------------------------------------------------
  it('Scenario 4: notification service down then up (circuit breaker, backoff, no lost notifications, idempotent)', async () => {
    const deviceId = 'dev-fail-notif-4';
    const rawKey = 'key-fail-notif-4';
    const ruleId = 'rule-fail-notif-4';
    await setupDevice(deviceId, rawKey);

    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'Notif Fail Rule', 'threshold', 'threshold',
               '{"field":"temperature","operator":">","value":50}'::jsonb,
               '{"type":"device","value":"dev-fail-notif-4"}'::jsonb, 'device', 'critical', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [ruleId]
    );
    queueWorker.invalidateRuleCache();

    // Clear any previous notifications for this sink to test clean circuit breaker transitions
    await pool.query('DELETE FROM notification_outbox WHERE destination_url = $1', [sinkUrl]);

    // 1. Sink is DOWN (returns 503)
    sinkMode = 'fail';
    sinkReceived.length = 0;

    // Trigger incident creation via queue worker (temp 60 matches rule > 50, but not rule-temp-high > 80)
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, schema_version, processing_status, attempts)
       VALUES ($1, $2, 1, NOW(), NOW(), 'telemetry', '{"temperature": 60}'::jsonb, 1, 'pending', 0)`,
      [eventId, deviceId]
    );

    await queueWorker.processBatch();

    const incident = (
      await pool.query('SELECT id FROM incidents WHERE rule_id = $1 AND device_id = $2', [
        ruleId,
        deviceId,
      ])
    ).rows[0];
    expect(incident).toBeDefined();

    const outboxItem = (
      await pool.query('SELECT id, status FROM notification_outbox WHERE incident_id = $1', [
        incident.id,
      ])
    ).rows[0];
    expect(outboxItem).toBeDefined();
    expect(outboxItem.status).toBe('pending');

    // Attempt delivery 1 while sink is DOWN -> fails with 503, attempts = 1
    await outboxWorker.processBatch();

    let outboxState = (
      await pool.query(
        'SELECT status, attempts, last_error FROM notification_outbox WHERE id = $1',
        [outboxItem.id]
      )
    ).rows[0];
    expect(outboxState.attempts).toBe(1);
    expect(outboxState.last_error).toContain('503');

    // Force next attempt immediately and trigger failure 2 -> trips circuit breaker (threshold = 2)
    await pool.query('UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = $1', [
      outboxItem.id,
    ]);
    await outboxWorker.processBatch();

    outboxState = (
      await pool.query('SELECT status, attempts FROM notification_outbox WHERE id = $1', [
        outboxItem.id,
      ])
    ).rows[0];
    expect(outboxState.attempts).toBe(2);

    // Check circuit breaker state in PostgreSQL
    const breakerRow = (
      await pool.query('SELECT state, failure_count FROM circuit_breaker_states WHERE host = $1', [
        `127.0.0.1:${sinkPort}`,
      ])
    ).rows[0];
    expect(breakerRow.state).toBe('OPEN');

    // While breaker is OPEN, worker claims the row but postpones delivery without burning attempts
    await pool.query('UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = $1', [
      outboxItem.id,
    ]);
    const claimedCount = await outboxWorker.processBatch();
    expect(claimedCount).toBe(1);

    // Invariant: notification attempts NOT incremented while breaker is OPEN; marked failed with breaker explanation
    const postponedState = (
      await pool.query(
        'SELECT status, attempts, last_error FROM notification_outbox WHERE id = $1',
        [outboxItem.id]
      )
    ).rows[0];
    expect(postponedState.status).toBe('failed');
    expect(postponedState.attempts).toBe(2);
    expect(postponedState.last_error).toContain('CircuitBreaker is OPEN');

    // 2. Sink RECOVERS (returns 200)
    sinkMode = 'ok';

    // Wait for circuit breaker reset timeout (500ms in test config)
    await new Promise((r) => setTimeout(r, 600));

    // Reset next_attempt_at to allow retry probe
    await pool.query('UPDATE notification_outbox SET next_attempt_at = NOW() WHERE id = $1', [
      outboxItem.id,
    ]);

    // Worker delivers the notification
    await outboxWorker.processBatch();

    // Invariant: notification delivered and status updated to 'sent'
    const finalOutbox = (
      await pool.query('SELECT status FROM notification_outbox WHERE id = $1', [outboxItem.id])
    ).rows[0];
    expect(finalOutbox.status).toBe('sent');

    // Invariant: sink received the notification with the exact outbox ID as Idempotency-Key
    expect(sinkReceived.length).toBe(1);
    expect(sinkReceived[0].idempotencyKey).toBe(outboxItem.id);
    expect(sinkReceived[0].body.incident_id).toBe(incident.id);
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 5: device offline then burst replay
  // Invariant: absence incident auto-resolved on reconnect, no duplicate threshold incidents
  // ---------------------------------------------------------------------------------------
  it('Scenario 5: device offline then burst replay (absence auto-resolve, bounded incident count)', async () => {
    const deviceId = 'dev-fail-burst-5';
    const rawKey = 'key-fail-burst-5';
    const absenceRuleId = 'rule-fail-abs-5';
    const threshRuleId = 'rule-fail-thr-5';
    await setupDevice(deviceId, rawKey);

    // Absence rule (timeout: 2s)
    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'Absence 2s Rule', 'absence', 'absence',
               '{"timeout_seconds":2}'::jsonb,
               '{"type":"device","value":"dev-fail-burst-5"}'::jsonb, 'device', 'warning', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [absenceRuleId]
    );

    // Threshold rule (temperature > 75)
    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'High Temp Burst Rule', 'threshold', 'threshold',
               '{"field":"temperature","operator":">","value":75}'::jsonb,
               '{"type":"device","value":"dev-fail-burst-5"}'::jsonb, 'device', 'critical', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [threshRuleId]
    );
    queueWorker.invalidateRuleCache();

    // 1. Device goes silent for 5 seconds (exceeds 2s threshold)
    await pool.query(
      "UPDATE devices SET last_seen_at = NOW() - INTERVAL '5 seconds', status = 'online' WHERE id = $1",
      [deviceId]
    );

    // Absence check runs and creates absence incident
    await absenceMonitor.runIteration();

    const openAbsenceInc = (
      await pool.query(
        "SELECT id, status FROM incidents WHERE rule_id = $1 AND device_id = $2 AND status = 'open'",
        [absenceRuleId, deviceId]
      )
    ).rows[0];
    expect(openAbsenceInc).toBeDefined();
    expect(openAbsenceInc.status).toBe('open');

    // 2. Device reconnects and sends a burst batch of 5 buffered events
    const burstBatch = [
      {
        event_id: randomUUID(),
        device_id: deviceId,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 82 }, // MATCH 1
        schema_version: 1,
      },
      {
        event_id: randomUUID(),
        device_id: deviceId,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 84 }, // MATCH 2
        schema_version: 1,
      },
      {
        event_id: randomUUID(),
        device_id: deviceId,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 20 }, // NORMAL
        schema_version: 1,
      },
      {
        event_id: randomUUID(),
        device_id: deviceId,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 86 }, // MATCH 3
        schema_version: 1,
      },
      {
        event_id: randomUUID(),
        device_id: deviceId,
        seq: 5,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 88 }, // MATCH 4
        schema_version: 1,
      },
    ];

    const burstRes = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: burstBatch,
    });
    expect(burstRes.statusCode).toBe(200);
    expect(burstRes.json().results.every((r: any) => r.status === 'accepted')).toBe(true);

    // Process all burst events through queue worker
    await queueWorker.processBatch();

    // Invariant: absence incident is AUTO-RESOLVED as soon as device reports
    const autoResolvedInc = (
      await pool.query('SELECT status FROM incidents WHERE id = $1', [openAbsenceInc.id])
    ).rows[0];
    expect(autoResolvedInc.status).toBe('auto_resolved');

    // Invariant: history entry recorded for auto-resolve (using timestamp column)
    const historyRows = await pool.query(
      'SELECT from_status, to_status, actor FROM incident_history WHERE incident_id = $1 ORDER BY timestamp DESC',
      [openAbsenceInc.id]
    );
    expect(historyRows.rows[0].to_status).toBe('auto_resolved');
    expect(historyRows.rows[0].actor).toBe('device_resume');

    // Invariant: exactly 1 threshold incident created for the 4 matching burst events
    const threshInc = (
      await pool.query(
        'SELECT id, status, occurrence_count FROM incidents WHERE rule_id = $1 AND device_id = $2',
        [threshRuleId, deviceId]
      )
    ).rows[0];
    expect(threshInc).toBeDefined();
    expect(threshInc.status).toBe('open');
    // Invariant: bounded incident count (occurrence_count = 4)
    expect(threshInc.occurrence_count).toBe(4);

    // Invariant: no lost events (all 5 burst events stored and done)
    const storedBurstEvents = await pool.query(
      'SELECT processing_status FROM events WHERE device_id = $1',
      [deviceId]
    );
    expect(storedBurstEvents.rowCount).toBe(5);
    expect(storedBurstEvents.rows.every((r) => r.processing_status === 'done')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 6: ingestion exceeding capacity (429 then drain)
  // Invariant: backpressure protects queue, 429 response + Retry-After, drain resumes acceptance
  // ---------------------------------------------------------------------------------------
  it('Scenario 6: ingestion exceeding capacity (429 backpressure, drain, normal ingestion resumes)', async () => {
    const deviceId = 'dev-fail-bp-6';
    const rawKey = 'key-fail-bp-6';
    await setupDevice(deviceId, rawKey);

    // Build dedicated test app with low backpressure threshold (3)
    const backpressureApp = buildServer(
      {
        ...apiConfig,
        effectiveMaxPending: 3,
        QUEUE_BACKPRESSURE_THRESHOLD: 3,
      },
      pool
    );

    // Seed 3 pending events to fill queue capacity
    for (let i = 1; i <= 3; i++) {
      await pool.query(
        `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, schema_version, processing_status, attempts)
         VALUES ($1, $2, $3, NOW(), NOW(), 'telemetry', '{"temperature": 25}'::jsonb, 1, 'pending', 0)`,
        [randomUUID(), deviceId, i]
      );
    }

    // Try ingesting new events while queue capacity is full -> 429 Too Many Requests
    const rejectedRes = await backpressureApp.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: [
        {
          event_id: randomUUID(),
          device_id: deviceId,
          seq: 4,
          ts: new Date().toISOString(),
          type: 'telemetry',
          payload: { temperature: 30 },
          schema_version: 1,
        },
      ],
    });
    expect(rejectedRes.statusCode).toBe(429);
    expect(rejectedRes.headers['retry-after']).toBe('5');
    expect(rejectedRes.json().error).toContain('backpressure');

    // Drain the queue by running QueueWorker
    await queueWorker.processBatch();

    // Verify queue depth has been drained (pending = 0)
    const pendingCount = (
      await pool.query(
        "SELECT COUNT(*) FROM events WHERE device_id = $1 AND processing_status = 'pending'",
        [deviceId]
      )
    ).rows[0].count;
    expect(Number(pendingCount)).toBe(0);

    // Wait for the 1000ms PendingDepthCache TTL to expire
    await new Promise((r) => setTimeout(r, 1100));

    // Retry ingestion after queue drain -> succeeds with 200 OK
    const acceptedEventId = randomUUID();
    const retryRes = await backpressureApp.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: [
        {
          event_id: acceptedEventId,
          device_id: deviceId,
          seq: 4,
          ts: new Date().toISOString(),
          type: 'telemetry',
          payload: { temperature: 30 },
          schema_version: 1,
        },
      ],
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().results[0].status).toBe('accepted');

    // Invariant: no lost accepted events
    const row = (
      await pool.query('SELECT processing_status FROM events WHERE event_id = $1', [
        acceptedEventId,
      ])
    ).rows[0];
    expect(row.processing_status).toBe('pending');

    await backpressureApp.close();
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 7: malformed payloads
  // Invariant: valid events preserved, malformed rejected to rejected_events, no poison incidents
  // ---------------------------------------------------------------------------------------
  it('Scenario 7: malformed payloads (per-event rejection, valid events accepted, rejected_events audit)', async () => {
    const deviceId = 'dev-fail-malformed-7';
    const rawKey = 'key-fail-malformed-7';
    await setupDevice(deviceId, rawKey);

    const validEvent1 = {
      event_id: randomUUID(),
      device_id: deviceId,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { temperature: 21 },
      schema_version: 1,
    };

    const malformedNoId = {
      device_id: deviceId,
      seq: 2,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { temperature: 22 },
      schema_version: 1,
    };

    const malformedFutureTs = {
      event_id: randomUUID(),
      device_id: deviceId,
      seq: 3,
      ts: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 minutes in future
      type: 'telemetry',
      payload: { temperature: 23 },
      schema_version: 1,
    };

    const validEvent2 = {
      event_id: randomUUID(),
      device_id: deviceId,
      seq: 2, // monotonically continues after valid event 1
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { temperature: 24 },
      schema_version: 1,
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${rawKey}` },
      payload: [validEvent1, malformedNoId, malformedFutureTs, validEvent2],
    });

    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results).toHaveLength(4);

    // Event 1: accepted
    expect(results[0].status).toBe('accepted');
    expect(results[0].event_id).toBe(validEvent1.event_id);

    // Event 2: rejected (missing event_id)
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason).toContain('event_id');

    // Event 3: rejected (ts > 5 min in future)
    expect(results[2].status).toBe('rejected');
    expect(results[2].reason).toContain('future');

    // Event 4: accepted
    expect(results[3].status).toBe('accepted');
    expect(results[3].event_id).toBe(validEvent2.event_id);

    // Invariant: valid events are committed into events table
    const storedValid = await pool.query('SELECT event_id FROM events WHERE event_id IN ($1, $2)', [
      validEvent1.event_id,
      validEvent2.event_id,
    ]);
    expect(storedValid.rowCount).toBe(2);

    // Invariant: rejected events are audited in rejected_events table
    const rejectedAudits = await pool.query(
      'SELECT reason FROM rejected_events WHERE device_id = $1',
      [deviceId]
    );
    expect(rejectedAudits.rowCount).toBeGreaterThanOrEqual(2);

    // Invariant: zero bogus incidents created
    const incidents = await pool.query('SELECT * FROM incidents WHERE device_id = $1', [deviceId]);
    expect(incidents.rowCount).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  // Scenario 8: SSE reconnect
  // Invariant: missed change_log rows replayed without gaps/duplicates, resync_required signal
  // ---------------------------------------------------------------------------------------
  it('Scenario 8: SSE reconnect (replays missed change_log rows without gaps, resync_required on buffer gap)', async () => {
    // 1. Insert 3 sequential change log rows
    const c1 = (
      await pool.query(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('device', 'dev-sse-1', 'UPDATE', '{"status":"online"}'::jsonb)
         RETURNING seq`
      )
    ).rows[0].seq;

    const c2 = (
      await pool.query(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('device', 'dev-sse-2', 'UPDATE', '{"status":"online"}'::jsonb)
         RETURNING seq`
      )
    ).rows[0].seq;

    const c3 = (
      await pool.query(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('device', 'dev-sse-3', 'UPDATE', '{"status":"online"}'::jsonb)
         RETURNING seq`
      )
    ).rows[0].seq;

    // Client reconnects with after_seq = c1 and close_after_replay=true -> should replay c2 and c3
    const streamRes = await app.inject({
      method: 'GET',
      url: `/api/stream?after_seq=${c1}&close_after_replay=true`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });

    expect(streamRes.statusCode).toBe(200);
    const body = streamRes.body;

    // Verify replay messages include c2 and c3
    expect(body).toContain(`id: ${c2}`);
    expect(body).toContain(`id: ${c3}`);
    // Invariant: does not replay already seen c1
    expect(body).not.toContain(`id: ${c1}\n`);

    // 2. Large gap test: client connects requesting after_seq = 0 when latest seq is >> 500
    const maxSeqRes = await pool.query('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM change_log');
    const maxSeq = Number(maxSeqRes.rows[0].max_seq);

    if (maxSeq > 500) {
      const resyncRes = await app.inject({
        method: 'GET',
        url: '/api/stream?after_seq=0&close_after_replay=true',
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      });

      expect(resyncRes.statusCode).toBe(200);
      expect(resyncRes.body).toContain('event: resync_required');
      expect(resyncRes.body).toContain('Replay gap');
    }
  });
});
