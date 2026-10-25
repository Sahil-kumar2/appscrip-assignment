import { describe, it, expect, vi } from 'vitest';
import { hashDeviceKey } from '../crypto.js';
import { isDeviceTimestampValid } from '../time.js';
import { calculateBackoffWithJitter, CircuitBreaker } from '../resilience.js';
import { IngestEventSchema, IngestBatchSchema } from '../schemas.js';

describe('Shared Package Unit Tests', () => {
  describe('Crypto: hashDeviceKey', () => {
    it('generates consistent SHA-256 hashes for the same key', () => {
      const hash1 = hashDeviceKey('secret-key-123');
      const hash2 = hashDeviceKey('secret-key-123');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('generates different hashes for different keys', () => {
      const hash1 = hashDeviceKey('secret-key-1');
      const hash2 = hashDeviceKey('secret-key-2');
      expect(hash1).not.toBe(hash2);
    });

    it('trims whitespace', () => {
      const hash1 = hashDeviceKey('  secret-key-123  ');
      const hash2 = hashDeviceKey('secret-key-123');
      expect(hash1).toBe(hash2);
    });
  });

  describe('Time: isDeviceTimestampValid', () => {
    const ref = new Date('2026-10-24T12:00:00Z');

    it('accepts past timestamps', () => {
      const past = new Date('2026-10-24T11:59:00Z');
      expect(isDeviceTimestampValid(past, 5, ref).valid).toBe(true);
    });

    it('accepts timestamps up to 5 minutes in the future', () => {
      const future4Min = new Date('2026-10-24T12:04:30Z');
      expect(isDeviceTimestampValid(future4Min, 5, ref).valid).toBe(true);
    });

    it('rejects timestamps more than 5 minutes in the future', () => {
      const future6Min = new Date('2026-10-24T12:06:00Z');
      const res = isDeviceTimestampValid(future6Min, 5, ref);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('in the future');
    });

    it('rejects invalid date strings', () => {
      const res = isDeviceTimestampValid('not-a-date', 5, ref);
      expect(res.valid).toBe(false);
    });
  });

  describe('Resilience: calculateBackoffWithJitter', () => {
    it('returns a delay within bounds [0, min(maxDelay, base * 2^attempt)]', () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = calculateBackoffWithJitter(attempt, 1000, 10000);
        const maxPossible = Math.min(10000, 1000 * Math.pow(2, attempt));
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(maxPossible);
      }
    });
  });

  describe('Resilience: CircuitBreaker', () => {
    it('transitions from CLOSED to OPEN after failure threshold is reached', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
      expect(cb.getState()).toBe('CLOSED');
      expect(cb.canExecute()).toBe(true);

      cb.recordFailure();
      expect(cb.getState()).toBe('CLOSED');
      cb.recordFailure();
      expect(cb.getState()).toBe('CLOSED');
      cb.recordFailure(); // threshold reached!
      expect(cb.getState()).toBe('OPEN');
      expect(cb.canExecute()).toBe(false);
    });

    it('blocks execution when OPEN', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
      cb.recordFailure();
      expect(cb.getState()).toBe('OPEN');

      await expect(cb.execute(async () => 'ok')).rejects.toThrow('CircuitBreaker is OPEN');
    });

    it('transitions to HALF_OPEN after resetTimeoutMs and closes after successful recovery', async () => {
      vi.useFakeTimers();
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1000,
        halfOpenSuccessThreshold: 2,
      });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe('OPEN');

      vi.advanceTimersByTime(1100);
      expect(cb.getState()).toBe('HALF_OPEN');
      expect(cb.canExecute()).toBe(true);

      cb.recordSuccess();
      expect(cb.getState()).toBe('HALF_OPEN');
      cb.recordSuccess(); // reached recovery threshold
      expect(cb.getState()).toBe('CLOSED');
      vi.useRealTimers();
    });
  });

  describe('Zod Schemas: IngestEventSchema & IngestBatchSchema', () => {
    const validEvent = {
      event_id: '123e4567-e89b-12d3-a456-426614174000',
      device_id: 'dev-001',
      seq: 1,
      ts: '2026-10-24T12:00:00Z',
      type: 'telemetry',
      payload: { temperature: 25.4 },
      schema_version: 1,
    };

    it('validates a correct event payload', () => {
      const parsed = IngestEventSchema.safeParse(validEvent);
      expect(parsed.success).toBe(true);
    });

    it('rejects schema_version != 1', () => {
      const parsed = IngestEventSchema.safeParse({ ...validEvent, schema_version: 2 });
      expect(parsed.success).toBe(false);
    });

    it('rejects non-uuid event_id', () => {
      const parsed = IngestEventSchema.safeParse({ ...validEvent, event_id: 'not-a-uuid' });
      expect(parsed.success).toBe(false);
    });

    it('rejects negative seq', () => {
      const parsed = IngestEventSchema.safeParse({ ...validEvent, seq: -1 });
      expect(parsed.success).toBe(false);
    });

    it('validates batch size boundaries', () => {
      expect(IngestBatchSchema.safeParse([]).success).toBe(false);
      expect(IngestBatchSchema.safeParse([validEvent]).success).toBe(true);
      const largeArray = new Array(501).fill(validEvent);
      expect(IngestBatchSchema.safeParse(largeArray).success).toBe(false);
    });
  });
});
