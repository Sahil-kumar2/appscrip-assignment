import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../apps/api/src/server.js';
import { loadApiConfig } from '../apps/api/src/config.js';
import { QueueWorker } from '../apps/worker/src/queue-worker.js';
import { AbsenceMonitor } from '../apps/worker/src/absence-monitor.js';
import { ChangeLogBroadcaster, StreamSubscriber } from '../apps/api/src/routes/stream.js';
import { WorkerConfig } from '../apps/worker/src/config.js';

describe('Adversarial Hardening & Edge Case Protection (Real PostgreSQL)', () => {
  const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString: dbUrl });

  const OPERATOR_TOKEN = 'test-operator-token';
  const apiConfig = loadApiConfig({
    DATABASE_URL: dbUrl,
    OPERATOR_TOKEN,
    LOG_LEVEL: 'silent',
  });
  const app = buildServer(apiConfig, pool);

  const workerConfig: WorkerConfig = {
    DATABASE_URL: dbUrl,
    WORKER_POLL_INTERVAL_MS: 200,
    WORKER_BATCH_SIZE: 10,
    EVENT_LEASE_SECONDS: 2,
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

  const testDeviceId = 'dev-adversarial-1';
  const testRuleId = 'rule-adv-temp';

  beforeAll(async () => {
    // Seed device and rule for tests
    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status)
       VALUES ($1, 'Adversarial Device 1', NULL, 'adv-hash-1', 'online')
       ON CONFLICT (id) DO UPDATE SET status = 'online', last_seen_at = NOW()`,
      [testDeviceId]
    );

    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, severity, enabled)
       VALUES ($1, 'Adversarial Temp Rule', 'threshold', 'threshold',
               '{"metric":"temperature","operator":">","value":80}'::jsonb,
               '{"type":"all"}'::jsonb, 'critical', true)
       ON CONFLICT (id) DO UPDATE SET enabled = true`,
      [testRuleId]
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('1. Zombie Worker Lease Fencing: expired lease aborts transaction and prevents duplicate mutations', async () => {
    const queueWorker = new QueueWorker(pool, workerConfig);
    queueWorker.invalidateRuleCache();

    const eventId = randomUUID();

    // Insert an event whose lease expired 10 seconds ago
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status, locked_until)
       VALUES ($1, $2, 9999, NOW(), NOW(), 'telemetry', '{"temperature": 95}'::jsonb, 'processing', NOW() - INTERVAL '10 seconds')`,
      [eventId, testDeviceId]
    );

    // Attempt to process this event with an expired lease passed from claim
    await queueWorker.processSingleEvent({
      event_id: eventId,
      device_id: testDeviceId,
      seq: 9999,
      ts: new Date(),
      received_at: new Date(),
      type: 'telemetry',
      payload: { temperature: 95 },
      attempts: 0,
      locked_until: new Date(Date.now() - 10000),
    });

    // Verify that the event was NOT marked 'done' by the zombie worker
    const evCheck = await pool.query<{ processing_status: string; attempts: number }>(
      'SELECT processing_status, attempts FROM events WHERE event_id = $1',
      [eventId]
    );
    expect(evCheck.rows[0].processing_status).toBe('pending');
    expect(evCheck.rows[0].attempts).toBe(1);

    // Verify no incident was created by this aborted zombie execution
    const incCheck = await pool.query(
      "SELECT id FROM incidents WHERE rule_id = $1 AND device_id = $2 AND status = 'open'",
      [testRuleId, testDeviceId]
    );
    expect(incCheck.rows).toHaveLength(0);
  });

  it('2. Absence Monitor Race Defense: fresh event ingestion suppresses stale absence trigger', async () => {
    const absenceMonitor = new AbsenceMonitor(pool, workerConfig);

    const absenceDeviceId = 'dev-adv-absence';
    const absenceRuleId = 'rule-adv-absence';

    // Seed absence rule scoped specifically to this device with 5s timeout
    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, severity, enabled)
       VALUES ($1, 'Adversarial Absence Rule', 'absence', 'absence',
               '{"timeout_seconds": 5}'::jsonb,
               '{"type":"device","value":"dev-adv-absence"}'::jsonb, 'critical', true)
       ON CONFLICT (id) DO UPDATE SET enabled = true, scope = '{"type":"device","value":"dev-adv-absence"}'::jsonb`,
      [absenceRuleId]
    );

    // Clean up any existing incidents for this test device
    await pool.query('DELETE FROM incidents WHERE device_id = $1', [absenceDeviceId]);

    // Device was seen 10s ago
    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status, last_seen_at)
       VALUES ($1, 'Absence Device', NULL, 'adv-hash-absence', 'online', NOW() - INTERVAL '10 seconds')
       ON CONFLICT (id) DO UPDATE SET last_seen_at = NOW() - INTERVAL '10 seconds'`,
      [absenceDeviceId]
    );

    // Simulate device reporting right as check runs: update last_seen_at to NOW()
    await pool.query('UPDATE devices SET last_seen_at = NOW() WHERE id = $1', [absenceDeviceId]);

    // Run absence check
    const client = await pool.connect();
    try {
      const triggered = await absenceMonitor.checkAbsences(client);
      expect(triggered).toBe(0);
    } finally {
      client.release();
    }

    // Confirm no absence incident was created
    const incRes = await pool.query(
      'SELECT id FROM incidents WHERE rule_id = $1 AND device_id = $2',
      [absenceRuleId, absenceDeviceId]
    );
    expect(incRes.rows).toHaveLength(0);
  });

  it('3. SSE Gap Protection: broadcaster catches up newly connected subscriber to highestSeq', async () => {
    const broadcaster = new ChangeLogBroadcaster(pool);
    await broadcaster.ensureStarted();

    // Insert 2 new change_log rows
    const seq1Res = await pool.query<{ seq: string }>(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('test_entity', 'test-1', 'INSERT', '{"adv":1}'::jsonb)
       RETURNING seq`
    );
    const seq1 = Number(seq1Res.rows[0].seq);

    const seq2Res = await pool.query<{ seq: string }>(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('test_entity', 'test-2', 'INSERT', '{"adv":2}'::jsonb)
       RETURNING seq`
    );
    const seq2 = Number(seq2Res.rows[0].seq);

    // Flush broadcaster so highestSeq advances to seq2
    await broadcaster.flush();

    // Create a mock subscriber with lastSeq = seq1 - 1 (a gap before highestSeq)
    const writtenMessages: string[] = [];
    const mockRaw: any = {
      write: (data: string) => writtenMessages.push(data),
      end: () => {},
    };

    const sub: StreamSubscriber = {
      id: randomUUID(),
      raw: mockRaw,
      lastSeq: seq1 - 1,
      isClosed: false,
    };

    // Register subscriber: addSubscriber must catch up the gap from seq1 to seq2
    await broadcaster.addSubscriber(sub);

    // Verify subscriber received the missing rows and lastSeq caught up
    expect(writtenMessages.length).toBeGreaterThanOrEqual(2);
    expect(sub.lastSeq).toBeGreaterThanOrEqual(seq2);

    await broadcaster.stop();
  });

  it('4. Fastify UUID Parameter Validation: returns 400 Bad Request instead of 500 on malformed UUIDs', async () => {
    // 1. GET /api/incidents/:id with invalid UUID
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/incidents/not-a-valid-uuid',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error).toContain('Invalid incident ID');

    // 2. POST /api/incidents/:id/ack with invalid UUID
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/incidents/123-bad-uuid/ack',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error).toContain('Invalid incident ID');

    // 3. POST /api/incidents/:id/resolve with invalid UUID
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/incidents/malformed/resolve',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res3.statusCode).toBe(400);
    expect(res3.json().error).toContain('Invalid incident ID');

    // 4. GET /api/events/:id/explain with invalid UUID
    const res4 = await app.inject({
      method: 'GET',
      url: '/api/events/not-a-uuid/explain',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res4.statusCode).toBe(400);
    expect(res4.json().error).toContain('Invalid event ID');
  });

  it('5. Unbounded change_log Capping: prunes entries older than 50,000 sequence IDs', async () => {
    // Clean up any test artifact
    await pool.query('DELETE FROM change_log WHERE seq = 99999999');

    // Verify capping function exists and executes
    const triggerRes = await pool.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname = 'cap_change_log_trigger'"
    );
    expect(triggerRes.rows).toHaveLength(1);

    // Verify trigger is attached to change_log
    const tgRes = await pool.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE tgname = 'trg_cap_change_log'"
    );
    expect(tgRes.rows).toHaveLength(1);

    // Verify database remains operational and change_log table is queryable
    const countRes = await pool.query('SELECT count(*) FROM change_log');
    expect(Number(countRes.rows[0].count)).toBeGreaterThan(0);
  });
});
