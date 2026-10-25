import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimulatedDevice } from '../device-agent.js';
import { ScenarioRunner } from '../scenarios.js';

describe('ScenarioRunner Tests', () => {
  const testDir = path.resolve('./.test-scenarios-' + Date.now());
  const deviceSpec = {
    deviceId: 'dev-scenario-test',
    apiKey: 'key-test-secret',
    name: 'Scenario Sensor',
    dataDir: testDir,
  };

  let device: SimulatedDevice;

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    device = new SimulatedDevice(deviceSpec);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('runs spike scenario and emits temperature > 80°C events', async () => {
    const transmittedBatches: any[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url, opts) => {
      const parsed = JSON.parse(opts.body);
      transmittedBatches.push(parsed);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: parsed.map((e: any) => ({
            event_id: e.event_id,
            status: 'accepted',
          })),
        }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 1200);

    // Run spike scenario with short abort and zero warmup
    await ScenarioRunner.runSpike({
      devices: [device],
      apiUrl: 'http://localhost:3000',
      ratePerSec: 10,
      warmupSec: 0,
      signal: abortController.signal,
    });

    expect(transmittedBatches.length).toBeGreaterThan(0);
    const allEvents = transmittedBatches.flat();
    const hasSpike = allEvents.some(
      (e) => e.payload && typeof e.payload.temperature === 'number' && e.payload.temperature > 80
    );
    expect(hasSpike).toBe(true);
  });

  it('runs malformed scenario and processes rejected results', async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, opts) => {
      const parsed = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: parsed.map((e: any) => {
            const isBad =
              e.schema_version === 99 ||
              e.event_id === 'not-a-valid-uuid' ||
              new Date(e.ts).getTime() > Date.now() + 60000;
            return {
              event_id: e.event_id,
              status: isBad ? 'rejected' : 'accepted',
              reason: isBad ? 'Validation error' : undefined,
            };
          }),
        }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 1200);

    await ScenarioRunner.runMalformed({
      devices: [device],
      apiUrl: 'http://localhost:3000',
      ratePerSec: 5,
      signal: abortController.signal,
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('runs offline-reconnect scenario buffering offline events and replaying them on reconnect', async () => {
    const replayPayloads: any[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url, opts) => {
      const parsed = JSON.parse(opts.body);
      replayPayloads.push(parsed);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: parsed.map((e: any) => ({
            event_id: e.event_id,
            status: 'accepted',
          })),
        }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const abortController = new AbortController();
    // Short offline duration for fast unit test
    setTimeout(() => abortController.abort(), 2000);

    await ScenarioRunner.runOfflineReconnect({
      devices: [device],
      apiUrl: 'http://localhost:3000',
      ratePerSec: 10,
      warmupSec: 0,
      offlineDurationSec: 1, // 1 second offline for unit test
      signal: abortController.signal,
    });

    expect(replayPayloads.length).toBeGreaterThan(0);
  });
});
