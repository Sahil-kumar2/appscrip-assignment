import { describe, it, expect } from 'vitest';
import { DeviceRateLimiter } from '../rate-limiter.js';

describe('DeviceRateLimiter', () => {
  it('allows requests within limit and tracks remaining', () => {
    const limiter = new DeviceRateLimiter(3, 1000);
    const r1 = limiter.check('dev-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check('dev-1');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check('dev-1');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = limiter.check('dev-1');
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetMs).toBeGreaterThan(0);
  });

  it('maintains independent rate limits for different devices', () => {
    const limiter = new DeviceRateLimiter(1, 1000);
    expect(limiter.check('dev-1').allowed).toBe(true);
    expect(limiter.check('dev-1').allowed).toBe(false);

    // dev-2 is unaffected
    expect(limiter.check('dev-2').allowed).toBe(true);
  });
});
