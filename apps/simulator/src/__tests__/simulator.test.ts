import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SimulatedDevice } from '../device-agent.js';

describe('SimulatedDevice Unit Tests', () => {
  const testDir = path.resolve('./.test-sim-unit-' + Date.now());
  let agent: SimulatedDevice;

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    agent = new SimulatedDevice({
      deviceId: 'dev-001',
      name: 'Sensor 1',
      apiKey: 'key-dev-001-secret',
      dataDir: testDir,
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('generates valid monotonic telemetry events', () => {
    const ev1 = agent.generateTelemetry();
    const ev2 = agent.generateTelemetry();

    expect(ev1.device_id).toBe('dev-001');
    expect(ev2.device_id).toBe('dev-001');
    expect(ev2.seq).toBe(ev1.seq + 1);
    expect(ev1.schema_version).toBe(1);
    expect(ev1.payload.temperature).toBeDefined();
  });

  it('generates high temperature anomaly when requested', () => {
    const ev = agent.generateSpike(90.5);
    expect(ev.payload.temperature).toBeGreaterThan(85);
  });

  it('generates heartbeat and error events', () => {
    const hb = agent.generateHeartbeat();
    const err = agent.generateError('ERR_HW_FAULT', 'Power rail voltage drop');
    expect(hb.type).toBe('device.heartbeat');
    expect(err.type).toBe('device.error');
    expect(err.payload.error_code).toBe('ERR_HW_FAULT');
  });

  it('generates duplicate events with preserved event_id and seq', () => {
    const orig = agent.generateTelemetry();
    const dup = agent.generateDuplicate();
    expect(dup).not.toBeNull();
    expect(dup?.event_id).toBe(orig.event_id);
    expect(dup?.seq).toBe(orig.seq);
  });
});
