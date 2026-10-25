import { describe, it, expect } from 'vitest';
import { parsePagination, SqlFilterBuilder } from '../utils/query-builder.js';

describe('Query Builder Utilities', () => {
  describe('parsePagination', () => {
    it('applies default limits when query params are missing', () => {
      const res = parsePagination({});
      expect(res.limit).toBe(50);
      expect(res.offset).toBe(0);
    });

    it('clamps limit to maxLimit', () => {
      const res = parsePagination({ limit: '999', offset: '20' }, 50, 100);
      expect(res.limit).toBe(100);
      expect(res.offset).toBe(20);
    });

    it('handles negative or invalid values gracefully', () => {
      const res = parsePagination({ limit: '-5', offset: 'invalid' });
      expect(res.limit).toBe(50);
      expect(res.offset).toBe(0);
    });
  });

  describe('SqlFilterBuilder', () => {
    it('builds parameterized conditions with correct positional placeholders', () => {
      const filter = new SqlFilterBuilder(1);
      filter.add((p) => `status = ${p}`, 'open');
      filter.add((p) => `device_id = ${p}`, 'dev-1');

      expect(filter.getWhereClause()).toBe('WHERE status = $1 AND device_id = $2');
      expect(filter.getParameters()).toEqual(['open', 'dev-1']);
    });

    it('ignores undefined, null, or empty values', () => {
      const filter = new SqlFilterBuilder();
      filter.add((p) => `status = ${p}`, undefined);
      filter.add((p) => `device_id = ${p}`, null);
      filter.add((p) => `location_id = ${p}`, '');

      expect(filter.getWhereClause()).toBe('');
      expect(filter.getParameters()).toEqual([]);
    });

    it('supports pushing custom parameters for limit and offset', () => {
      const filter = new SqlFilterBuilder();
      filter.add((p) => `status = ${p}`, 'open');
      const limitPh = filter.pushParam(20);
      const offsetPh = filter.pushParam(10);

      expect(limitPh).toBe('$2');
      expect(offsetPh).toBe('$3');
      expect(filter.getParameters()).toEqual(['open', 20, 10]);
    });
  });
});
