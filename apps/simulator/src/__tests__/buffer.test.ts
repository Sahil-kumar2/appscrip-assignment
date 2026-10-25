import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileBackedBuffer } from '../buffer.js';
import { IngestEvent } from '@aps/shared';

describe('FileBackedBuffer', () => {
  const testDir = path.resolve('./.test-simulator-buffer-' + Date.now());
  const deviceId = 'dev-test-buffer';

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('initializes empty and persists monotonic seq increments', () => {
    const buffer = new FileBackedBuffer(deviceId, testDir);
    expect(buffer.getLastSeq()).toBe(0);
    expect(buffer.getBufferSize()).toBe(0);

    const s1 = buffer.nextSeq();
    const s2 = buffer.nextSeq();
    const s3 = buffer.nextSeq();

    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);
    expect(buffer.getLastSeq()).toBe(3);

    // Re-create buffer instance (simulating process restart)
    const restarted = new FileBackedBuffer(deviceId, testDir);
    expect(restarted.getLastSeq()).toBe(3);
    expect(restarted.nextSeq()).toBe(4);
  });

  it('persists buffered events and survives simulator restart', () => {
    const buffer = new FileBackedBuffer(deviceId, testDir);
    const ev1: IngestEvent = {
      event_id: randomUUID(),
      device_id: deviceId,
      seq: buffer.nextSeq(),
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { temperature: 21.5 },
      schema_version: 1,
    };
    const ev2: IngestEvent = {
      event_id: randomUUID(),
      device_id: deviceId,
      seq: buffer.nextSeq(),
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: { temperature: 22.0 },
      schema_version: 1,
    };

    buffer.append(ev1);
    buffer.append(ev2);
    expect(buffer.getBufferSize()).toBe(2);

    // Restart process
    const bufferAfterRestart = new FileBackedBuffer(deviceId, testDir);
    expect(bufferAfterRestart.getBufferSize()).toBe(2);
    const buffered = bufferAfterRestart.getBufferedEvents();
    expect(buffered[0].event_id).toBe(ev1.event_id);
    expect(buffered[1].event_id).toBe(ev2.event_id);
    expect(buffered[0].seq).toBe(1);
    expect(buffered[1].seq).toBe(2);
  });

  it('evicts acknowledged events and maintains recent acknowledgedIds', () => {
    const buffer = new FileBackedBuffer(deviceId, testDir);
    const eid1 = randomUUID();
    const eid2 = randomUUID();

    buffer.append({
      event_id: eid1,
      device_id: deviceId,
      seq: 1,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: {},
      schema_version: 1,
    });
    buffer.append({
      event_id: eid2,
      device_id: deviceId,
      seq: 2,
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: {},
      schema_version: 1,
    });

    expect(buffer.getBufferSize()).toBe(2);
    buffer.markAcknowledged([eid1]);

    expect(buffer.getBufferSize()).toBe(1);
    expect(buffer.getBufferedEvents()[0].event_id).toBe(eid2);
    expect(buffer.getAcknowledgedIds()).toContain(eid1);

    // Reload from disk to ensure acknowledgedIds persisted
    const reloaded = new FileBackedBuffer(deviceId, testDir);
    expect(reloaded.getBufferSize()).toBe(1);
    expect(reloaded.getAcknowledgedIds()).toContain(eid1);
  });
});
