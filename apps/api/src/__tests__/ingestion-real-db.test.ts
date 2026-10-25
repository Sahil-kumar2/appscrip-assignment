import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hashDeviceKey } from '@aps/shared';
import { buildServer } from '../server.js';
import { ApiConfig } from '../config.js';

describe('Real PostgreSQL: Ingestion API (POST /v1/events)', () => {
  const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aps';
  const pool = new pg.Pool({ connectionString: dbUrl });

  const testDeviceId = 'dev-test-real';
  const testRawKey = 'test-real-key-secret-98765';
  const testKeyHash = hashDeviceKey(testRawKey);

  const config: ApiConfig = {
    PORT: 3001,
    HOST: '0.0.0.0',
    DATABASE_URL: dbUrl,
    QUEUE_BACKPRESSURE_THRESHOLD: 1000,
    LATE_EVENT_WINDOW_SECONDS: 300,
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 1000,
    OPERATOR_TOKEN: 'operator-secret-token',
    LOG_LEVEL: 'silent',
    effectiveMaxPending: 1000,
  };

  const app = buildServer(config, pool);

  beforeAll(async () => {
    // Ensure test device exists in DB
    await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status, last_seq, last_event_ts)
       VALUES ($1, 'Real DB Test Device', 'loc-warehouse-1', $2, 'offline', 0, NULL)
       ON CONFLICT (id) DO UPDATE 
       SET key_hash = EXCLUDED.key_hash,
           status = 'offline',
           last_seq = 0,
           last_event_ts = NULL`,
      [testDeviceId, testKeyHash]
    );

    // Clean up any previous test events
    await pool.query('DELETE FROM events WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM rejected_events WHERE device_id = $1', [testDeviceId]);
  });

  afterAll(async () => {
    // Cleanup test data
    await pool.query('DELETE FROM events WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM rejected_events WHERE device_id = $1', [testDeviceId]);
    await pool.query('DELETE FROM devices WHERE id = $1', [testDeviceId]);
    await app.close();
    await pool.end();
  });

  it('wrong key: rejects with 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: 'Bearer wrong-unauthorized-key' },
      payload: [
        {
          event_id: randomUUID(),
          device_id: testDeviceId,
          seq: 1,
          ts: new Date().toISOString(),
          type: 'telemetry',
          payload: { temperature: 22 },
          schema_version: 1,
        },
      ],
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain('Unauthorized');
  });

  it('garbage body: returns 400 and never 500 or crashes', async () => {
    // 1. Non-array JSON object
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: { notAnArray: true },
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error).toContain('must be a JSON array');

    // 2. Empty array
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: [],
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error).toContain('at least 1 event');

    // 3. String body instead of array
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: {
        authorization: `Bearer ${testRawKey}`,
        'content-type': 'application/json',
      },
      payload: 'this is not valid json array',
    });
    expect(res3.statusCode).toBe(400);
  });

  it('oversized batch: rejects batch exceeding 500 events with 400', async () => {
    const oversized = Array.from({ length: 501 }, (_, i) => ({
      event_id: randomUUID(),
      device_id: testDeviceId,
      seq: i + 1,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: {},
      schema_version: 1,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: oversized,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('exceeds maximum limit of 500');
  });

  it('happy path: accepts valid batch and updates device metadata transactionally', async () => {
    const eventId1 = randomUUID();
    const eventId2 = randomUUID();
    const ts1 = new Date(Date.now() - 1000).toISOString();
    const ts2 = new Date().toISOString();

    const batch = [
      {
        event_id: eventId1,
        device_id: testDeviceId,
        seq: 1,
        ts: ts1,
        type: 'telemetry',
        payload: { temperature: 25.4, humidity: 60 },
        schema_version: 1,
      },
      {
        event_id: eventId2,
        device_id: testDeviceId,
        seq: 2,
        ts: ts2,
        type: 'status',
        payload: { battery: 95 },
        schema_version: 1,
      },
    ];

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: batch,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual({ event_id: eventId1, status: 'accepted' });
    expect(body.results[1]).toEqual({ event_id: eventId2, status: 'accepted' });

    // Verify stored events in PostgreSQL
    const dbEvents = await pool.query(
      'SELECT event_id, device_id, seq, processing_status, attempts, is_late FROM events WHERE device_id = $1 ORDER BY seq ASC',
      [testDeviceId]
    );
    expect(dbEvents.rows).toHaveLength(2);
    expect(dbEvents.rows[0].event_id).toBe(eventId1);
    expect(['pending', 'processing', 'done']).toContain(dbEvents.rows[0].processing_status);
    expect(dbEvents.rows[0].attempts).toBe(0);
    expect(dbEvents.rows[0].is_late).toBe(false);

    // Verify device updated to online with updated seq and timestamp
    const devRes = await pool.query(
      'SELECT status, last_seq, last_seen_at FROM devices WHERE id = $1',
      [testDeviceId]
    );
    expect(devRes.rows[0].status).toBe('online');
    expect(Number(devRes.rows[0].last_seq)).toBe(2);
    expect(devRes.rows[0].last_seen_at).toBeDefined();

    // Verify change_log entries created
    const changeLogs = await pool.query(
      "SELECT entity, entity_id, op FROM change_log WHERE entity = 'event' AND entity_id IN ($1, $2)",
      [eventId1, eventId2]
    );
    expect(changeLogs.rows).toHaveLength(2);
    expect(changeLogs.rows[0].op).toBe('INSERT');
  });

  it('duplicate within a batch and across batches: deduplicates idempotently', async () => {
    const duplicateEventId = randomUUID();
    const uniqueEventId = randomUUID();

    // Intra-batch duplicates: duplicateEventId appears twice in the same batch
    const intraBatch = [
      {
        event_id: duplicateEventId,
        device_id: testDeviceId,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { reading: 100 },
        schema_version: 1,
      },
      {
        event_id: duplicateEventId, // same event_id in same batch
        device_id: testDeviceId,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { reading: 100 },
        schema_version: 1,
      },
      {
        event_id: uniqueEventId,
        device_id: testDeviceId,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { reading: 101 },
        schema_version: 1,
      },
    ];

    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: intraBatch,
    });

    expect(res1.statusCode).toBe(200);
    const results1 = res1.json().results;
    expect(results1).toHaveLength(3);
    expect(results1[0]).toEqual({ event_id: duplicateEventId, status: 'accepted' });
    expect(results1[1].status).toBe('duplicate');
    expect(results1[1].reason).toContain('Duplicate event_id within batch');
    expect(results1[2]).toEqual({ event_id: uniqueEventId, status: 'accepted' });

    // Inter-batch duplicates: sending duplicateEventId again in a subsequent request
    const interBatch = [
      {
        event_id: duplicateEventId,
        device_id: testDeviceId,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { reading: 100 },
        schema_version: 1,
      },
    ];

    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: interBatch,
    });

    expect(res2.statusCode).toBe(200);
    const results2 = res2.json().results;
    expect(results2).toHaveLength(1);
    expect(results2[0].status).toBe('duplicate');
    expect(results2[0].reason).toContain('already accepted');

    // Confirm DB has exactly 1 row for duplicateEventId
    const countRes = await pool.query('SELECT count(*) FROM events WHERE event_id = $1', [
      duplicateEventId,
    ]);
    expect(Number(countRes.rows[0].count)).toBe(1);
  });

  it('out-of-order timestamps and sequence numbers', async () => {
    // Current max seq is 4. Now send seq: 30 with future-ish timestamp (within 5 min),
    // then send an out-of-order older seq: 10 with older timestamp.
    const eventSeq30 = randomUUID();
    const eventSeq10 = randomUUID();
    const futureTime = new Date(Date.now() + 60 * 1000).toISOString(); // +1 min (valid)
    const pastTime = new Date(Date.now() - 60 * 1000).toISOString(); // -1 min (valid)

    // Send seq 30 first
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: [
        {
          event_id: eventSeq30,
          device_id: testDeviceId,
          seq: 30,
          ts: futureTime,
          type: 'telemetry',
          payload: { order: 'seq30' },
          schema_version: 1,
        },
      ],
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().results[0].status).toBe('accepted');

    // Verify last_seq is 30
    let dev = await pool.query('SELECT last_seq, last_event_ts FROM devices WHERE id = $1', [
      testDeviceId,
    ]);
    expect(Number(dev.rows[0].last_seq)).toBe(30);

    // Send seq 10 with older past timestamp
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: [
        {
          event_id: eventSeq10,
          device_id: testDeviceId,
          seq: 10,
          ts: pastTime,
          type: 'telemetry',
          payload: { order: 'seq10' },
          schema_version: 1,
        },
      ],
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().results[0].status).toBe('accepted');

    // Verify last_seq remains 30 (GREATEST(30, 10) = 30)
    dev = await pool.query('SELECT last_seq, last_event_ts FROM devices WHERE id = $1', [
      testDeviceId,
    ]);
    expect(Number(dev.rows[0].last_seq)).toBe(30);
  });

  it('malformed payloads in a mixed batch: per-event rejected and stored in rejected_events', async () => {
    const validEventId = randomUUID();
    const badSchemaId = 'bad-non-uuid-id';

    const mixedBatch = [
      // 1. Valid event
      {
        event_id: validEventId,
        device_id: testDeviceId,
        seq: 31,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temp: 21 },
        schema_version: 1,
      },
      // 2. Bad schema: invalid UUID, missing seq, wrong schema_version
      {
        event_id: badSchemaId,
        device_id: testDeviceId,
        ts: new Date().toISOString(),
        type: 'telemetry',
        schema_version: 99,
      },
      // 3. Mismatched device_id
      {
        event_id: randomUUID(),
        device_id: 'dev-some-other-device',
        seq: 32,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: {},
        schema_version: 1,
      },
    ];

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: mixedBatch,
    });

    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results).toHaveLength(3);

    // 1st accepted
    expect(results[0]).toEqual({ event_id: validEventId, status: 'accepted' });

    // 2nd rejected due to schema
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason).toContain('Validation error');

    // 3rd rejected due to mismatched device_id
    expect(results[2].status).toBe('rejected');
    expect(results[2].reason).toContain('does not match authenticated device');

    // Verify rejected_events table recorded the rejections
    const rejRes = await pool.query(
      'SELECT device_id, reason FROM rejected_events WHERE device_id = $1 ORDER BY id DESC LIMIT 2',
      [testDeviceId]
    );
    expect(rejRes.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('future timestamp: rejects events more than 5 minutes in future', async () => {
    const farFutureTs = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 min
    const eventId = randomUUID();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: [
        {
          event_id: eventId,
          device_id: testDeviceId,
          seq: 40,
          ts: farFutureTs,
          type: 'telemetry',
          payload: {},
          schema_version: 1,
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toContain('Timestamp is');
  });

  it('backpressure: returns 429 + Retry-After when pending count exceeds threshold', async () => {
    // Build server instance with low backpressure threshold = 2
    const lowThresholdConfig: ApiConfig = {
      ...config,
      QUEUE_BACKPRESSURE_THRESHOLD: 2,
      effectiveMaxPending: 2,
    };
    const lowApp = buildServer(lowThresholdConfig, pool);

    // Insert 3 pending events for testDeviceId to exceed threshold (count = 3 >= 2)
    // Set locked_until in the future so background worker doesn't immediately consume them
    const testEv1 = randomUUID();
    const testEv2 = randomUUID();
    const testEv3 = randomUUID();
    await pool.query(
      `INSERT INTO events (event_id, device_id, seq, ts, type, processing_status, locked_until)
       VALUES 
       ($1, $2, 901, NOW(), 't', 'pending', NOW() + INTERVAL '1 hour'),
       ($3, $2, 902, NOW(), 't', 'pending', NOW() + INTERVAL '1 hour'),
       ($4, $2, 903, NOW(), 't', 'pending', NOW() + INTERVAL '1 hour')`,
      [testEv1, testDeviceId, testEv2, testEv3]
    );

    const res = await lowApp.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${testRawKey}` },
      payload: [
        {
          event_id: randomUUID(),
          device_id: testDeviceId,
          seq: 904,
          ts: new Date().toISOString(),
          type: 'telemetry',
          payload: {},
          schema_version: 1,
        },
      ],
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json().error).toContain('Ingestion queue backpressure');

    await lowApp.close();
    // Clean up temporary pending events
    await pool.query('DELETE FROM events WHERE event_id IN ($1, $2, $3)', [
      testEv1,
      testEv2,
      testEv3,
    ]);
  });

  it('concurrency: 100 parallel identical batches yield exactly one stored copy of each event', async () => {
    const concurrentEventId = randomUUID();
    const concurrentEventPayload = [
      {
        event_id: concurrentEventId,
        device_id: testDeviceId,
        seq: 500,
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { pressure: 101.3 },
        schema_version: 1,
      },
    ];

    // Fire 100 identical requests simultaneously
    const requests = Array.from({ length: 100 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: { authorization: `Bearer ${testRawKey}` },
        payload: concurrentEventPayload,
      })
    );

    const responses = await Promise.all(requests);

    // All 100 responses must be HTTP 200
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    // Extract statuses across all 100 responses
    const allStatuses = responses.map((r) => r.json().results[0].status);
    const acceptedCount = allStatuses.filter((s) => s === 'accepted').length;
    const duplicateCount = allStatuses.filter((s) => s === 'duplicate').length;

    // Exactly 1 must be 'accepted', and exactly 99 must be 'duplicate'
    expect(acceptedCount).toBe(1);
    expect(duplicateCount).toBe(99);

    // Check database single-row guarantee
    const countCheck = await pool.query('SELECT count(*) FROM events WHERE event_id = $1', [
      concurrentEventId,
    ]);
    expect(Number(countCheck.rows[0].count)).toBe(1);
  });
});
