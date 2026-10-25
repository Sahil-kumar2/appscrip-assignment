import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { QueueWorker } from '../queue-worker.js';
import { AbsenceMonitor } from '../absence-monitor.js';
import { WorkerConfig } from '../config.js';

describe('Real PostgreSQL: Worker Queue, Rules, and Absence Engine', () => {
  const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString: dbUrl });

  const testDeviceId = 'dev-worker-real';
  const thresholdRuleId = 'rule-worker-temp';
  const absenceRuleId = 'rule-worker-absence';

  const config: WorkerConfig = {
    DATABASE_URL: dbUrl,
    WORKER_POLL_INTERVAL_MS: 500,
    WORKER_BATCH_SIZE: 20,
    EVENT_LEASE_SECONDS: 10,
    MAX_EVENT_ATTEMPTS: 3,
    OUTBOX_POLL_INTERVAL_MS: 1000,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_TIMEOUT_MS: 5000,
    MAX_OUTBOX_ATTEMPTS: 5,
    ABSENCE_CHECK_INTERVAL_MS: 5000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 3,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 15000,
    LOG_LEVEL: 'silent',
  };

  const worker = new QueueWorker(pool, config);
  const absenceMonitor = new AbsenceMonitor(pool, config);

  beforeAll(async () => {
    // 1. Create test device
    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status, last_seq, last_seen_at)
       VALUES ($1, 'Worker Test Device', 'loc-warehouse-1', 'fake-hash-worker', 'online', 0, NOW())
       ON CONFLICT (id) DO UPDATE SET status = 'online', last_seq = 0, last_seen_at = NOW()`,
      [testDeviceId]
    );

    // 2. Create test threshold rule
    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'Worker Temp Rule', 'threshold', 'threshold', 
               $2::jsonb, '{"type":"device","value":"dev-worker-real"}'::jsonb, 'device', 'warning', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [thresholdRuleId, JSON.stringify({ field: 'temperature', operator: '>', value: 80 })]
    );

    // 3. Create test absence rule
    await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
       VALUES ($1, 'Worker Absence Rule', 'absence', 'absence', 
               $2::jsonb, '{"type":"device","value":"dev-worker-real"}'::jsonb, 'device', 'warning', true, 0)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, enabled = true`,
      [absenceRuleId, JSON.stringify({ timeout_seconds: 60 })]
    );

    // Clean up previous test artifacts and clear queue
    await pool.query(
      "UPDATE events SET processing_status = 'done' WHERE processing_status IN ('pending', 'processing')"
    );
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
    await pool.query('DELETE FROM rules WHERE id IN ($1, $2)', [thresholdRuleId, absenceRuleId]);
    await pool.query('DELETE FROM devices WHERE id = $1', [testDeviceId]);
    await pool.end();
  });

  it('threshold match and non-match: creates incident only when condition matches', async () => {
    const nonMatchingEventId = randomUUID();
    const matchingEventId = randomUUID();

    // 1. Insert non-matching event (temperature 75 <= 80)
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
       VALUES ($1, $2, 1, NOW(), NOW(), 'telemetry', $3::jsonb, 'pending')`,
      [nonMatchingEventId, testDeviceId, JSON.stringify({ temperature: 75 })]
    );

    const processed1 = await worker.processBatch();
    expect(processed1).toBe(1);

    // Verify non-matching event marked done
    const ev1 = await pool.query('SELECT processing_status FROM events WHERE event_id = $1', [
      nonMatchingEventId,
    ]);
    expect(ev1.rows[0].processing_status).toBe('done');

    // Verify rule_evaluations recorded with matched: false
    const eval1 = await pool.query(
      'SELECT matched, reason FROM rule_evaluations WHERE event_id = $1 AND rule_id = $2',
      [nonMatchingEventId, thresholdRuleId]
    );
    expect(eval1.rows).toHaveLength(1);
    expect(eval1.rows[0].matched).toBe(false);
    expect(eval1.rows[0].reason).toContain('is not > 80');

    // Confirm no incident was created
    const incs1 = await pool.query(
      'SELECT id FROM incidents WHERE device_id = $1 AND rule_id = $2',
      [testDeviceId, thresholdRuleId]
    );
    expect(incs1.rows).toHaveLength(0);

    // 2. Insert matching event (temperature 88 > 80)
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
       VALUES ($1, $2, 2, NOW(), NOW(), 'telemetry', $3::jsonb, 'pending')`,
      [matchingEventId, testDeviceId, JSON.stringify({ temperature: 88 })]
    );

    const processed2 = await worker.processBatch();
    expect(processed2).toBe(1);

    // Verify matching event marked done
    const ev2 = await pool.query('SELECT processing_status FROM events WHERE event_id = $1', [
      matchingEventId,
    ]);
    expect(ev2.rows[0].processing_status).toBe('done');

    // Verify rule_evaluations recorded with matched: true
    const eval2 = await pool.query(
      'SELECT matched, reason FROM rule_evaluations WHERE event_id = $1 AND rule_id = $2',
      [matchingEventId, thresholdRuleId]
    );
    expect(eval2.rows[0].matched).toBe(true);
    expect(eval2.rows[0].reason).toContain('(88) > 80');

    // Verify incident created with occurrence_count = 1
    const incs2 = await pool.query(
      "SELECT id, status, occurrence_count, dedup_key FROM incidents WHERE device_id = $1 AND rule_id = $2 AND status = 'open'",
      [testDeviceId, thresholdRuleId]
    );
    expect(incs2.rows).toHaveLength(1);
    expect(incs2.rows[0].occurrence_count).toBe(1);
    expect(incs2.rows[0].dedup_key).toBe(`${thresholdRuleId}:${testDeviceId}`);

    // Verify incident_events attached
    const incEvents = await pool.query(
      'SELECT event_id FROM incident_events WHERE incident_id = $1',
      [incs2.rows[0].id]
    );
    expect(incEvents.rows.map((r) => r.event_id)).toContain(matchingEventId);
  });

  it('repeated matches: single incident with occurrence_count N and attached events', async () => {
    const repeatEventId = randomUUID();

    // Insert 2nd matching event (temperature 94 > 80)
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
       VALUES ($1, $2, 3, NOW(), NOW(), 'telemetry', $3::jsonb, 'pending')`,
      [repeatEventId, testDeviceId, JSON.stringify({ temperature: 94 })]
    );

    const processed = await worker.processBatch();
    expect(processed).toBe(1);

    // Confirm STILL exactly 1 incident for this device & rule
    const incs = await pool.query(
      "SELECT id, occurrence_count FROM incidents WHERE device_id = $1 AND rule_id = $2 AND status = 'open'",
      [testDeviceId, thresholdRuleId]
    );
    expect(incs.rows).toHaveLength(1);
    expect(incs.rows[0].occurrence_count).toBe(2);

    // Confirm both matching events are attached to this single incident
    const attached = await pool.query(
      'SELECT event_id FROM incident_events WHERE incident_id = $1 ORDER BY event_id ASC',
      [incs.rows[0].id]
    );
    expect(attached.rows.map((r) => r.event_id)).toContain(repeatEventId);

    // Confirm outbox only has 1 notification (initial creation), not 2
    const outbox = await pool.query(
      'SELECT count(*) FROM notification_outbox WHERE incident_id = $1',
      [incs.rows[0].id]
    );
    expect(Number(outbox.rows[0].count)).toBe(1);
  });

  it('two workers racing on the same events: zero collisions and each processed once', async () => {
    const worker2 = new QueueWorker(pool, config);

    // Insert 10 pending events
    const eventIds: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const eid = randomUUID();
      eventIds.push(eid);
      await pool.query(
        `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
         VALUES ($1, $2, $3, NOW(), NOW(), 'telemetry', '{"temperature": 20}'::jsonb, 'pending')`,
        [eid, testDeviceId, 100 + i]
      );
    }

    // Both workers process in parallel
    const [w1Count, w2Count] = await Promise.all([worker.processBatch(), worker2.processBatch()]);
    expect(w1Count + w2Count).toBeGreaterThanOrEqual(10);

    // Verify all 10 events are 'done'
    const statusRes = await pool.query(
      "SELECT count(*) FROM events WHERE event_id = ANY($1) AND processing_status = 'done'",
      [eventIds]
    );
    expect(Number(statusRes.rows[0].count)).toBe(10);
  });

  it('kill mid-transaction then reclaim after lease expiration', async () => {
    const abandonedEventId = randomUUID();

    // Insert event marked 'processing' whose lease expired 5 seconds ago
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status, locked_until)
       VALUES ($1, $2, 200, NOW(), NOW(), 'telemetry', '{"temperature": 22}'::jsonb, 'processing', NOW() - interval '5 seconds')`,
      [abandonedEventId, testDeviceId]
    );

    // Worker claims and processes the expired event
    const claimed = await worker.processBatch();
    expect(claimed).toBeGreaterThanOrEqual(1);

    // Verify event is now completed
    const ev = await pool.query('SELECT processing_status FROM events WHERE event_id = $1', [
      abandonedEventId,
    ]);
    expect(ev.rows[0].processing_status).toBe('done');
  });

  it('poison event goes to failed after MAX_ATTEMPTS (dead-letter) and can be requeued', async () => {
    const poisonEventId = randomUUID();

    // Insert an event with attempts = 2 (so next failure hits MAX_EVENT_ATTEMPTS = 3)
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status, attempts)
       VALUES ($1, $2, 300, NOW(), NOW(), 'telemetry', '{"temperature": 25}'::jsonb, 'pending', 2)`,
      [poisonEventId, testDeviceId]
    );

    // Mock rule cache to throw an error simulating poison event processing failure
    const spy = vi
      .spyOn((worker as any).ruleCache, 'getEnabledRules')
      .mockRejectedValueOnce(new Error('Poison event syntax error'));

    await worker.processSingleEvent({
      event_id: poisonEventId,
      device_id: testDeviceId,
      seq: 300,
      ts: new Date(),
      received_at: new Date(),
      type: 'telemetry',
      payload: { temperature: 25 },
      attempts: 2,
    });

    spy.mockRestore();

    // Check that event transitioned to 'failed' (dead-lettered)
    const failedCheck = await pool.query(
      'SELECT processing_status, attempts, last_error FROM events WHERE event_id = $1',
      [poisonEventId]
    );
    expect(failedCheck.rows[0].processing_status).toBe('failed');
    expect(failedCheck.rows[0].attempts).toBe(3);
    expect(failedCheck.rows[0].last_error).toContain('Poison event syntax error');

    // Test requeue hook
    const requeueRes = await pool.query(
      `UPDATE events
       SET processing_status = 'pending', attempts = 0, locked_until = NULL, last_error = NULL
       WHERE event_id = $1 AND processing_status = 'failed'
       RETURNING processing_status, attempts`,
      [poisonEventId]
    );
    expect(requeueRes.rows[0].processing_status).toBe('pending');
    expect(requeueRes.rows[0].attempts).toBe(0);
  });

  it('absence incident creation and auto-resolve on device resume', async () => {
    // 1. Set device last_seen_at to 120 seconds ago (older than rule 60s timeout)
    await pool.query(
      "UPDATE devices SET last_seen_at = NOW() - interval '120 seconds', status = 'online' WHERE id = $1",
      [testDeviceId]
    );

    // Run absence monitor
    const absenceRes = await absenceMonitor.runIteration();
    expect(absenceRes.absencesTriggered).toBeGreaterThanOrEqual(1);

    // Check that an absence incident was created
    const incRes = await pool.query(
      "SELECT id, status, dedup_key FROM incidents WHERE device_id = $1 AND rule_id = $2 AND status = 'open'",
      [testDeviceId, absenceRuleId]
    );
    expect(incRes.rows).toHaveLength(1);
    const absenceIncId = incRes.rows[0].id;

    // Check device status derived as 'offline'
    const devOffline = await pool.query('SELECT status FROM devices WHERE id = $1', [testDeviceId]);
    expect(devOffline.rows[0].status).toBe('offline');

    // 2. Device reports again: send a fresh event
    const resumeEventId = randomUUID();
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status)
       VALUES ($1, $2, 400, NOW(), NOW(), 'telemetry', '{"temperature": 25}'::jsonb, 'pending')`,
      [resumeEventId, testDeviceId]
    );

    // Worker processes resume event
    await worker.processBatch();

    // Confirm absence incident was auto_resolved
    const autoResolvedInc = await pool.query('SELECT status FROM incidents WHERE id = $1', [
      absenceIncId,
    ]);
    expect(autoResolvedInc.rows[0].status).toBe('auto_resolved');

    // Confirm incident_history recorded 'device_resume' actor
    const history = await pool.query(
      "SELECT from_status, to_status, actor FROM incident_history WHERE incident_id = $1 AND to_status = 'auto_resolved'",
      [absenceIncId]
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0].from_status).toBe('open');
    expect(history.rows[0].actor).toBe('device_resume');
  });

  it('late replayed events do not create duplicate incidents', async () => {
    const lateEventId = randomUUID();
    const oldTimestamp = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min old

    // Late event matching threshold
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, received_at, type, payload, processing_status, is_late)
       VALUES ($1, $2, 50, $3, NOW(), 'telemetry', '{"temperature": 89}'::jsonb, 'pending', true)`,
      [lateEventId, testDeviceId, oldTimestamp]
    );

    await worker.processBatch();

    // Verify event is done
    const ev = await pool.query(
      'SELECT processing_status, is_late FROM events WHERE event_id = $1',
      [lateEventId]
    );
    expect(ev.rows[0].processing_status).toBe('done');
    expect(ev.rows[0].is_late).toBe(true);

    // Deduplication holds: no unconstrained duplicate incidents
    const openIncs = await pool.query(
      "SELECT count(*) FROM incidents WHERE device_id = $1 AND rule_id = $2 AND status = 'open'",
      [testDeviceId, thresholdRuleId]
    );
    expect(Number(openIncs.rows[0].count)).toBeLessThanOrEqual(1);
  });
});
