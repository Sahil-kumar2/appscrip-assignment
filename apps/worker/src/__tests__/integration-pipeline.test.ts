import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueueWorker } from '../queue-worker.js';
import { WorkerConfig } from '../config.js';

describe('End-to-End Worker Pipeline & Incident Lifecycle', () => {
  const config: WorkerConfig = {
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/aps',
    WORKER_POLL_INTERVAL_MS: 500,
    WORKER_BATCH_SIZE: 10,
    EVENT_LEASE_SECONDS: 30,
    MAX_EVENT_ATTEMPTS: 5,
    OUTBOX_POLL_INTERVAL_MS: 1000,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_TIMEOUT_MS: 5000,
    MAX_OUTBOX_ATTEMPTS: 5,
    ABSENCE_CHECK_INTERVAL_MS: 5000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 3,
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 15000,
    LOG_LEVEL: 'silent',
  };

  let mockPool: any;
  let mockClient: any;
  let worker: QueueWorker;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn(),
      connect: vi.fn().mockResolvedValue(mockClient),
    };

    worker = new QueueWorker(mockPool, config);
  });

  it('claims events with SKIP LOCKED, evaluates rules, and creates incident + outbox', async () => {
    const event = {
      event_id: '11111111-1111-1111-1111-111111111111',
      device_id: 'dev-001',
      seq: 1,
      ts: new Date(),
      received_at: new Date(),
      type: 'telemetry',
      payload: { temperature: 95.0 }, // > 85 triggers rule-temp-high
      attempts: 0,
    };

    // 1. Batch claim transaction
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim query
      .mockResolvedValueOnce({}) // update lease
      .mockResolvedValueOnce({}); // COMMIT

    // 2. Single event processing transaction
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'dev-001',
            location_id: 'loc-1',
            operator_id: 'op-alice',
            webhook_url: 'http://notification-sink:4000/webhook',
          },
        ],
      }) // fetch device & operator
      .mockResolvedValueOnce({ rows: [] }) // check active absence incidents (none)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'rule-temp-high',
            name: 'High Temperature Critical',
            rule_type: 'threshold',
            scope_type: 'all',
            config: { field: 'temperature', operator: '>', value: 85 },
            enabled: true,
            severity: 'warning',
            cooldown: 0,
          },
        ],
      }) // fetch active rules
      .mockResolvedValueOnce({}) // insert rule_evaluations
      .mockResolvedValueOnce({
        rows: [{ id: 'new-inc-1', is_new: true, severity: 'warning', occurrence_count: 1 }],
      }) // upsert incident (is_new = true)
      .mockResolvedValueOnce({}) // insert incident_events
      .mockResolvedValueOnce({}) // insert incident_history
      .mockResolvedValueOnce({}) // insert change_log
      .mockResolvedValueOnce({}) // insert notification_outbox
      .mockResolvedValueOnce({}) // update events set processing_status = done
      .mockResolvedValueOnce({}); // COMMIT

    const count = await worker.processBatch();
    expect(count).toBe(1);

    // Verify lease was set
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET processing_status = 'processing'"),
      [30, [event.event_id]]
    );

    // Verify incident creation
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incidents'),
      expect.arrayContaining([
        'rule-temp-high:dev-001',
        'rule-temp-high',
        'dev-001',
        event.event_id,
      ])
    );

    // Verify transactional outbox notification created in same transaction
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notification_outbox'),
      expect.arrayContaining(['op-alice', 'http://notification-sink:4000/webhook'])
    );

    // Verify event marked done
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET processing_status = 'done'"),
      [event.event_id]
    );
  });

  it('increments occurrence_count and attaches event when active incident already exists (deduplication)', async () => {
    const event = {
      event_id: '22222222-2222-2222-2222-222222222222',
      device_id: 'dev-001',
      seq: 2,
      ts: new Date(),
      received_at: new Date(),
      type: 'telemetry',
      payload: { temperature: 96.0 }, // match
      attempts: 0,
    };

    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'dev-001',
            location_id: 'loc-1',
            operator_id: 'op-alice',
            webhook_url: 'http://test',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'rule-temp-high',
            name: 'High Temperature Critical',
            rule_type: 'threshold',
            scope_type: 'all',
            config: { field: 'temperature', operator: '>', value: 85 },
            enabled: true,
            severity: 'warning',
            cooldown: 0,
          },
        ],
      })
      .mockResolvedValueOnce({}) // rule_evaluations
      // UPSERT ACTIVE INCIDENT (is_new = false)
      .mockResolvedValueOnce({
        rows: [{ id: 'existing-inc-id', is_new: false, severity: 'warning', occurrence_count: 4 }],
      })
      .mockResolvedValueOnce({}) // insert incident_events (attach event)
      .mockResolvedValueOnce({}) // change_log update
      .mockResolvedValueOnce({}) // update events done
      .mockResolvedValueOnce({});

    await worker.processBatch();

    // Verify incident upsert was called with dedup_key
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incidents'),
      expect.arrayContaining(['rule-temp-high:dev-001', 'rule-temp-high', 'dev-001'])
    );

    // Verify event was attached to existing incident
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incident_events'),
      ['existing-inc-id', event.event_id]
    );
  });

  it('auto-resolves active absence incident when device reports again', async () => {
    const event = {
      event_id: '33333333-3333-3333-3333-333333333333',
      device_id: 'dev-003',
      seq: 10,
      ts: new Date(),
      received_at: new Date(),
      type: 'telemetry',
      payload: { temperature: 25.0 },
      attempts: 0,
    };

    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'dev-003',
            location_id: 'loc-2',
            operator_id: 'op-bob',
            webhook_url: 'http://test',
          },
        ],
      })
      // Found active absence incident on this device!
      .mockResolvedValueOnce({
        rows: [{ id: 'absence-inc-1', status: 'open', rule_id: 'rule-device-absence' }],
      })
      .mockResolvedValueOnce({}) // update incidents set status = auto_resolved
      .mockResolvedValueOnce({}) // insert incident_history actor: device_resume
      .mockResolvedValueOnce({}) // insert change_log
      .mockResolvedValueOnce({ rows: [] }) // active rules
      .mockResolvedValueOnce({}) // mark event done
      .mockResolvedValueOnce({});

    await worker.processBatch();

    // Verify auto_resolved status update
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'auto_resolved'"),
      ['absence-inc-1']
    );

    // Verify incident_history audit entry with actor device_resume
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO incident_history'),
      ['absence-inc-1', 'open', expect.stringContaining('Device resumed transmitting')]
    );
  });
});
