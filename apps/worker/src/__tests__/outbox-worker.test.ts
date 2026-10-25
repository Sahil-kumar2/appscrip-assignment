import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxWorker } from '../outbox-worker.js';
import { WorkerConfig } from '../config.js';

describe('OutboxWorker & Circuit Breaker', () => {
  const config: WorkerConfig = {
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/aps',
    WORKER_POLL_INTERVAL_MS: 500,
    WORKER_BATCH_SIZE: 10,
    EVENT_LEASE_SECONDS: 30,
    MAX_EVENT_ATTEMPTS: 5,
    OUTBOX_POLL_INTERVAL_MS: 1000,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_TIMEOUT_MS: 5000,
    MAX_OUTBOX_ATTEMPTS: 3, // 3 attempts then dead
    ABSENCE_CHECK_INTERVAL_MS: 5000,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 2, // trip after 2 failures
    CIRCUIT_BREAKER_RESET_TIMEOUT_MS: 1000,
    LOG_LEVEL: 'silent',
  };

  let mockPool: any;
  let mockClient: any;
  let outboxWorker: OutboxWorker;

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(mockClient),
    };

    outboxWorker = new OutboxWorker(mockPool, config);
  });

  it('delivers notification successfully and updates outbox to delivered', async () => {
    const record = {
      id: 'outbox-1',
      incident_id: 'inc-1',
      operator_id: 'op-alice',
      destination_url: 'http://notification-sink:4000/webhook',
      payload: { msg: 'alert' },
      attempts: 0,
    };

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [record] }) // claim
      .mockResolvedValueOnce({}) // set in_flight
      .mockResolvedValueOnce({}); // COMMIT

    // Mock fetch success
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const processed = await outboxWorker.processBatch();
    expect(processed).toBe(1);
    expect(mockFetch).toHaveBeenCalledWith(
      record.destination_url,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Idempotency-Key': record.id,
        }),
      })
    );

    // Verify delivery status updated in DB
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'sent'"), [
      record.id,
    ]);

    vi.unstubAllGlobals();
  });

  it('retries with failure and marks as dead when max attempts reached', async () => {
    const record = {
      id: 'outbox-1',
      incident_id: 'inc-1',
      operator_id: 'op-alice',
      destination_url: 'http://notification-sink:4000/webhook',
      payload: { msg: 'alert' },
      attempts: 2, // At 2 attempts, this failure makes it 3 (equal to MAX_OUTBOX_ATTEMPTS)
    };

    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [record] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    // Mock fetch network failure
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Connection timeout')));

    await outboxWorker.processBatch();

    // Verify marked as dead
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('SET status = $1'), [
      'dead',
      3,
      expect.any(Number),
      'Connection timeout',
      record.id,
    ]);

    vi.unstubAllGlobals();
  });

  it('trips circuit breaker and postpones notifications without making HTTP requests', async () => {
    const dest = 'http://failing-host:4000/webhook';
    const cb = outboxWorker.getCircuitBreaker(dest);

    // Simulate 2 failures to trip circuit
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');

    const record = {
      id: 'outbox-2',
      incident_id: 'inc-2',
      operator_id: 'op-bob',
      destination_url: dest,
      payload: {},
      attempts: 0,
    };

    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [record] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await outboxWorker.processBatch();

    // fetch should NOT have been called because circuit is OPEN
    expect(mockFetch).not.toHaveBeenCalled();

    // Outbox notification should be postponed
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('CircuitBreaker is OPEN'), [
      record.id,
    ]);

    vi.unstubAllGlobals();
  });
});
