import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimulatedDevice } from '../device-agent.js';

describe('SimulatedDevice Unit Tests', () => {
  const testDir = path.resolve('./.test-device-agent-' + Date.now());
  const deviceSpec = {
    deviceId: 'dev-sim-test-01',
    apiKey: 'key-test-secret',
    name: 'Test Sensor Unit',
    dataDir: testDir,
  };

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('generates valid telemetry, heartbeat, and error events with monotonic sequence', () => {
    const dev = new SimulatedDevice(deviceSpec);

    const t1 = dev.generateTelemetry(22, 1);
    const t2 = dev.generateTelemetry(22, 1);
    const hb = dev.generateHeartbeat();
    const err = dev.generateError('ERR_OVERLOAD');

    expect(t1.type).toBe('telemetry');
    expect(t1.payload.temperature).toBeGreaterThan(20);
    expect(t2.seq).toBe(t1.seq + 1);
    expect(hb.type).toBe('device.heartbeat');
    expect(hb.seq).toBe(t2.seq + 1);
    expect(err.type).toBe('device.error');
    expect(err.seq).toBe(hb.seq + 1);

    expect(dev.buffer.getBufferSize()).toBe(4);
  });

  it('handles 200 OK batch transmission and evicts acknowledged events', async () => {
    const dev = new SimulatedDevice(deviceSpec);
    const ev1 = dev.generateTelemetry();
    const ev2 = dev.generateTelemetry();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { event_id: ev1.event_id, status: 'accepted' },
          { event_id: ev2.event_id, status: 'accepted' },
        ],
      }),
    });

    const res = await dev.transmitBatch('http://localhost:3000', {
      fetchFn: mockFetch as any,
    });

    expect(res.success).toBe(true);
    expect(res.acceptedCount).toBe(2);
    expect(dev.buffer.getBufferSize()).toBe(0);
    expect(dev.getState()).toBe('connected');
  });

  it('handles 429 Too Many Requests and honours Retry-After header', async () => {
    const dev = new SimulatedDevice(deviceSpec);
    dev.generateTelemetry();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: {
        get: (h: string) => (h.toLowerCase() === 'retry-after' ? '7' : null),
      },
    });

    const res = await dev.transmitBatch('http://localhost:3000', {
      fetchFn: mockFetch as any,
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe(429);
    expect(res.retryAfterSec).toBe(7);
    expect(dev.getPausedUntil()).toBeGreaterThan(Date.now() + 5000);
    expect(dev.buffer.getBufferSize()).toBe(1); // events kept in buffer!

    // Next transmit attempt while paused should immediately abort without calling network
    const secondCall = await dev.transmitBatch('http://localhost:3000', {
      fetchFn: mockFetch as any,
    });
    expect(secondCall.success).toBe(false);
    expect(secondCall.error).toContain('Rate limited / backoff active');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles network failure by transitioning to offline, buffering, and backing off', async () => {
    const dev = new SimulatedDevice(deviceSpec);
    dev.generateTelemetry();

    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const res = await dev.transmitBatch('http://localhost:3000', {
      fetchFn: mockFetch as any,
    });

    expect(res.success).toBe(false);
    expect(dev.getState()).toBe('offline');
    expect(dev.buffer.getBufferSize()).toBe(1);
    expect(dev.getPausedUntil()).toBeGreaterThan(Date.now());
  });

  it('replays buffer in chunks on reconnect with chunk shuffling and intentional dedup injection', async () => {
    const dev = new SimulatedDevice(deviceSpec);

    // Initial event accepted to populate acknowledged cache
    const initialEv = dev.generateTelemetry();
    await dev.transmitBatch('http://localhost:3000', {
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{ event_id: initialEv.event_id, status: 'accepted' }],
        }),
      }) as any,
    });
    expect(dev.buffer.getBufferSize()).toBe(0);

    // Now generate 5 new events while simulated offline
    dev.setNetworkDisabled(true);
    expect(dev.getState()).toBe('offline');

    const offlineEvents = [];
    for (let i = 0; i < 5; i++) {
      offlineEvents.push(dev.generateTelemetry());
    }
    expect(dev.buffer.getBufferSize()).toBe(5);

    // Network restores!
    dev.setNetworkDisabled(false);
    expect(dev.getState()).toBe('replaying');

    const sentPayloads: any[] = [];
    const mockReplayFetch = vi.fn().mockImplementation(async (_url, opts) => {
      const parsed = JSON.parse(opts.body);
      sentPayloads.push(parsed);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: parsed.map((e: any) => ({
            event_id: e.event_id,
            status: e.event_id === initialEv.event_id ? 'duplicate' : 'accepted',
          })),
        }),
      };
    });

    const replayRes = await dev.replayBuffer('http://localhost:3000', {
      chunkSize: 2,
      resendAcked: true,
      shuffleChunks: true,
      fetchFn: mockReplayFetch as any,
    });

    expect(replayRes.success).toBe(true);
    expect(dev.buffer.getBufferSize()).toBe(0);
    expect(dev.getState()).toBe('connected');

    // Verify intentional dedup was injected
    const allSentIds = sentPayloads.flat().map((e: any) => e.event_id);
    expect(allSentIds).toContain(initialEv.event_id);

    // Verify multiple chunks were transmitted
    expect(sentPayloads.length).toBeGreaterThanOrEqual(2);
  });
});
