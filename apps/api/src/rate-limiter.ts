export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * In-memory token bucket rate limiter per device.
 * Enforces per-device rate limits with burst allowance and smooth token refill.
 */
export class DeviceRateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 120, windowMs: number = 60000) {
    this.capacity = maxRequests;
    this.windowMs = windowMs;
    this.refillRatePerMs = maxRequests / windowMs;

    // Periodically prune stale device buckets every 2 minutes
    setInterval(() => this.cleanup(), 120000).unref();
  }

  public check(deviceId: string, cost: number = 1): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(deviceId);

    if (!bucket) {
      bucket = {
        tokens: this.capacity,
        lastRefill: now,
      };
      this.buckets.set(deviceId, bucket);
    } else {
      // Refill tokens based on elapsed time since last refill
      const elapsedMs = Math.max(0, now - bucket.lastRefill);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMs * this.refillRatePerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetMs: Math.ceil((this.capacity - bucket.tokens) / this.refillRatePerMs),
      };
    }

    const deficit = cost - bucket.tokens;
    const resetMs = Math.ceil(deficit / this.refillRatePerMs);

    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(1, resetMs),
    };
  }

  public reset(deviceId?: string): void {
    if (deviceId) {
      this.buckets.delete(deviceId);
    } else {
      this.buckets.clear();
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [deviceId, bucket] of this.buckets.entries()) {
      if (bucket.tokens >= this.capacity && now - bucket.lastRefill > this.windowMs) {
        this.buckets.delete(deviceId);
      }
    }
  }
}
