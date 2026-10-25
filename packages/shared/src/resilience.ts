/**
 * Calculates exponential backoff with full jitter to avoid thundering herds.
 * Formula: delay = Math.random() * min(maxDelayMs, baseDelayMs * 2^attempt)
 */
export function calculateBackoffWithJitter(
  attempt: number,
  baseDelayMs: number = 1000,
  maxDelayMs: number = 60000
): number {
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt)));
  // Full jitter: uniformly random between 0 and exponentialDelay
  return Math.floor(Math.random() * exponentialDelay);
}

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // failures before opening (default: 3)
  resetTimeoutMs?: number; // ms to wait before testing half-open (default: 10000)
  halfOpenSuccessThreshold?: number; // successes in half-open before closing (default: 2)
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private nextAttemptAt = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10000;
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 2;
  }

  public getState(): CircuitBreakerState {
    const now = Date.now();
    if (this.state === 'OPEN' && now >= this.nextAttemptAt) {
      this.state = 'HALF_OPEN';
      this.consecutiveSuccesses = 0;
    }
    return this.state;
  }

  public canExecute(): boolean {
    const currentState = this.getState();
    return currentState === 'CLOSED' || currentState === 'HALF_OPEN';
  }

  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  public recordSuccess(): void {
    const currentState = this.getState();
    if (currentState === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.reset();
      }
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  public recordFailure(): void {
    const currentState = this.getState();
    if (currentState === 'HALF_OPEN') {
      // Re-trip immediately
      this.trip();
    } else if (currentState === 'CLOSED') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.trip();
      }
    }
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error(`CircuitBreaker is OPEN. Executions are temporarily blocked.`);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private trip(): void {
    this.state = 'OPEN';
    this.nextAttemptAt = Date.now() + this.resetTimeoutMs;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }

  private reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.nextAttemptAt = 0;
  }
}
