import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';
import { ApiConfig } from '../config.js';

describe('SSE Stream with Last-Event-ID Replay', () => {
  const config: ApiConfig = {
    PORT: 3000,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/aps',
    QUEUE_BACKPRESSURE_THRESHOLD: 100,
    LATE_EVENT_WINDOW_SECONDS: 300,
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 100,
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

  it('replays missed events when Last-Event-ID header is provided', async () => {
    // 1. Gap check query
    mockPool.query.mockResolvedValueOnce({
      rows: [{ max_seq: '42', gap_count: '2' }],
    });

    // 2. Replay query returns missed events where seq > 40
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          seq: 41,
          entity_type: 'event',
          entity_id: 'ev-41',
          action: 'INSERT',
          payload: { type: 'telemetry' },
          created_at: new Date().toISOString(),
        },
        {
          seq: 42,
          entity_type: 'incident',
          entity_id: 'inc-42',
          action: 'INSERT',
          payload: { status: 'open' },
          created_at: new Date().toISOString(),
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/stream?close_after_replay=true',
      headers: {
        authorization: 'Bearer operator-secret-token',
        'last-event-id': '40',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    // Verify replay query was executed with $1 = 40
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE seq > $1'), [40]);

    // Verify SSE wire format includes id and data
    const payload = res.payload;
    expect(payload).toContain('id: 41');
    expect(payload).toContain('event: change');
    expect(payload).toContain('"seq":41');
    expect(payload).toContain('id: 42');
    expect(payload).toContain('"seq":42');
  });

  it('finds current max seq when no Last-Event-ID is provided', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ max_seq: '150' }],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/stream?close_after_replay=true',
      headers: {
        authorization: 'Bearer operator-secret-token',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('MAX(seq)'));
  });

  it('rejects unauthorized connection to /api/stream with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream',
    });
    expect(res.statusCode).toBe(401);
  });
});
