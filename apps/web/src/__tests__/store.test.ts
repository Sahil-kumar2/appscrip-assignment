import { describe, it, expect } from 'vitest';
import {
  initialPlatformState,
  applyChangeLogItem,
  applyChangeLogBatch,
  platformReducer,
  NormalizedPlatformState,
} from '../store/platformReducer.js';
import { StreamChangeLogItem } from '../types.js';

describe('Normalized Platform Store & Idempotent Stream Application', () => {
  it('applies sequential entity updates correctly', () => {
    let state = initialPlatformState;

    // 1. Insert Device
    const devChange: StreamChangeLogItem = {
      seq: 1,
      entity: 'device',
      entity_id: 'dev-1',
      op: 'INSERT',
      data: { id: 'dev-1', name: 'Sensor 1', status: 'online', location_id: 'loc-1' },
      created_at: new Date().toISOString(),
    };
    state = applyChangeLogItem(state, devChange);
    expect(state.devices['dev-1']).toBeDefined();
    expect(state.devices['dev-1'].name).toBe('Sensor 1');
    expect(state.devices['dev-1'].status).toBe('online');
    expect(state.lastSeq).toBe(1);

    // 2. Insert Incident
    const incChange: StreamChangeLogItem = {
      seq: 2,
      entity: 'incident',
      entity_id: 'inc-100',
      op: 'INSERT',
      data: {
        id: 'inc-100',
        device_id: 'dev-1',
        rule_name: 'Overheat',
        status: 'open',
        severity: 'critical',
        occurrence_count: 1,
      },
      created_at: new Date().toISOString(),
    };
    state = applyChangeLogItem(state, incChange);
    expect(state.incidents['inc-100']).toBeDefined();
    expect(state.incidents['inc-100'].status).toBe('open');
    expect(state.lastSeq).toBe(2);
  });

  it('idempotently ignores already-seen duplicate seq numbers', () => {
    let state = initialPlatformState;

    const change: StreamChangeLogItem = {
      seq: 15,
      entity: 'incident',
      entity_id: 'inc-100',
      op: 'UPDATE',
      data: { id: 'inc-100', status: 'acknowledged', occurrence_count: 2 },
      created_at: new Date().toISOString(),
    };

    // First application
    state = applyChangeLogItem(state, change);
    expect(state.incidents['inc-100'].status).toBe('acknowledged');
    expect(state.incidents['inc-100'].occurrence_count).toBe(2);
    expect(state.lastSeq).toBe(15);
    expect(state.seenSeqs.has(15)).toBe(true);

    // Second application with the EXACT same sequence ID (duplicate replay)
    const duplicateChange: StreamChangeLogItem = {
      seq: 15,
      entity: 'incident',
      entity_id: 'inc-100',
      op: 'UPDATE',
      data: { id: 'inc-100', status: 'resolved', occurrence_count: 999 }, // Should be completely ignored!
      created_at: new Date().toISOString(),
    };

    const nextState = applyChangeLogItem(state, duplicateChange);

    // Must remain unchanged
    expect(nextState).toBe(state); // Reference equality: untouched
    expect(nextState.incidents['inc-100'].status).toBe('acknowledged');
    expect(nextState.incidents['inc-100'].occurrence_count).toBe(2);
  });

  it('handles out-of-order changes without breaking lastSeq or seenSeqs', () => {
    let state = initialPlatformState;

    // Item with seq = 50 arrives first
    const change50: StreamChangeLogItem = {
      seq: 50,
      entity: 'device',
      entity_id: 'dev-50',
      op: 'INSERT',
      data: { id: 'dev-50', name: 'High Seq Device', status: 'online' },
      created_at: new Date().toISOString(),
    };
    state = applyChangeLogItem(state, change50);
    expect(state.lastSeq).toBe(50);
    expect(state.devices['dev-50']).toBeDefined();

    // Out-of-order item with seq = 42 arrives later
    const change42: StreamChangeLogItem = {
      seq: 42,
      entity: 'device',
      entity_id: 'dev-42',
      op: 'INSERT',
      data: { id: 'dev-42', name: 'Older Seq Device', status: 'stale' },
      created_at: new Date().toISOString(),
    };
    state = applyChangeLogItem(state, change42);

    // Both devices are applied
    expect(state.devices['dev-42']).toBeDefined();
    expect(state.devices['dev-42'].name).toBe('Older Seq Device');
    // lastSeq remains at the highest seen sequence (50)
    expect(state.lastSeq).toBe(50);
    expect(state.seenSeqs.has(42)).toBe(true);
    expect(state.seenSeqs.has(50)).toBe(true);

    // Replay of out-of-order change 42 is ignored
    const nextState = applyChangeLogItem(state, change42);
    expect(nextState).toBe(state);
  });

  it('handles DELETE operations cleanly', () => {
    let state = initialPlatformState;

    // Create rule
    state = applyChangeLogItem(state, {
      seq: 1,
      entity: 'rule',
      entity_id: 'rule-del-1',
      op: 'INSERT',
      data: { id: 'rule-del-1', name: 'Rule to Delete', type: 'threshold' },
      created_at: new Date().toISOString(),
    });
    expect(state.rules['rule-del-1']).toBeDefined();

    // Delete rule
    state = applyChangeLogItem(state, {
      seq: 2,
      entity: 'rule',
      entity_id: 'rule-del-1',
      op: 'DELETE',
      data: {},
      created_at: new Date().toISOString(),
    });
    expect(state.rules['rule-del-1']).toBeUndefined();
  });

  it('caps liveEvents list in memory under burst batch', () => {
    let state = initialPlatformState;

    const batch: StreamChangeLogItem[] = [];
    for (let i = 1; i <= 300; i++) {
      batch.push({
        seq: i,
        entity: 'event',
        entity_id: `ev-${i}`,
        op: 'INSERT',
        data: {
          event_id: `ev-${i}`,
          device_id: 'dev-1',
          seq: i,
          type: 'telemetry',
          payload: { val: i },
        },
        created_at: new Date().toISOString(),
      });
    }

    state = applyChangeLogBatch(state, batch);

    // Capped at 250 items
    expect(state.liveEvents.length).toBe(250);
    // Most recent is at index 0
    expect(state.liveEvents[0].seq).toBe(300);
    expect(state.lastSeq).toBe(300);
  });
});
