import { describe, it, expect, vi } from 'vitest';
import { IngestionService } from '../services/ingestion.service.js';

describe('IngestionService Unit Tests', () => {
  const service = new IngestionService(300);

  it('validates batch format correctly', () => {
    expect(service.validateRawBatch(null).error).toContain('must be a JSON array');
    expect(service.validateRawBatch([]).error).toContain('must contain at least 1 event');
    expect(service.validateRawBatch(new Array(501).fill({})).error).toContain(
      'exceeds maximum limit of 500'
    );

    const validBatch = [{ event_id: '123' }];
    const res = service.validateRawBatch(validBatch);
    expect(res.error).toBeUndefined();
    expect(res.batch).toBe(validBatch);
  });

  it('rejects invalid event schemas and logs them into rejected_events', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    const mockClient = { query: mockQuery } as any;

    const device = {
      id: 'dev-001',
      location_id: 'loc-1',
      status: 'offline',
      last_seq: 0,
      last_event_ts: null,
      key_hash: 'hash-1',
    };

    const invalidItem = { invalid: true };
    const outcome = await service.ingestBatch(mockClient, device, [invalidItem]);

    expect(outcome.rejectedCount).toBe(1);
    expect(outcome.acceptedCount).toBe(0);
    expect(outcome.results[0].status).toBe('rejected');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO rejected_events'),
      expect.any(Array)
    );
  });
});
