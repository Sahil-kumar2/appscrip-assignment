import pg from 'pg';
import { CircuitBreaker, calculateBackoffWithJitter, createLogger } from '@aps/shared';
import { WorkerConfig } from './config.js';

const logger = createLogger({ service: 'outbox-worker' });

export class OutboxWorker {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly pool: pg.Pool;
  private readonly config: WorkerConfig;
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();

  constructor(pool: pg.Pool, config: WorkerConfig) {
    this.pool = pool;
    this.config = config;
  }

  /**
   * Returns a CircuitBreaker scoped to the webhook host to ensure
   * a single dead destination sink does not burn worker resources.
   */
  public getCircuitBreaker(destinationUrl: string): CircuitBreaker {
    let host = destinationUrl;
    try {
      host = new URL(destinationUrl).host;
    } catch {
      // Fallback to full string if URL parsing fails
    }

    let cb = this.circuitBreakers.get(host);
    if (!cb) {
      cb = new CircuitBreaker({
        failureThreshold: this.config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        resetTimeoutMs: this.config.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
        halfOpenSuccessThreshold: 1,
      });
      this.circuitBreakers.set(host, cb);
    }
    return cb;
  }

  /**
   * Reclaims notifications left stranded in 'in_flight' status from a prior process crash.
   */
  public async reclaimInFlight(): Promise<number> {
    try {
      const res = await this.pool.query(
        `UPDATE notification_outbox
         SET status = 'pending', updated_at = NOW()
         WHERE status = 'in_flight'
         RETURNING id`
      );
      if (res.rows.length > 0) {
        logger.info(
          { count: res.rows.length },
          'Reclaimed in_flight notifications on startup/recovery'
        );
      }
      return res.rows.length;
    } catch (err) {
      logger.error({ err }, 'Failed to reclaim in_flight notifications');
      return 0;
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('OutboxWorker started');

    // On start, reclaim any stranded in_flight notifications
    await this.reclaimInFlight();

    this.scheduleNext(0);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('OutboxWorker stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        const processedCount = await this.processBatch();
        const nextDelay =
          processedCount >= this.config.OUTBOX_BATCH_SIZE ? 0 : this.config.OUTBOX_POLL_INTERVAL_MS;
        this.scheduleNext(nextDelay);
      } catch (err) {
        logger.error({ err }, 'Error in outbox worker iteration');
        this.scheduleNext(this.config.OUTBOX_POLL_INTERVAL_MS);
      }
    }, delayMs);
  }

  /**
   * Polls notification_outbox where status in ('pending', 'failed') and next_attempt_at <= now,
   * plus reclaims any 'in_flight' records older than 30s with FOR UPDATE SKIP LOCKED.
   */
  public async processBatch(): Promise<number> {
    const client = await this.pool.connect();
    let records: Array<{
      id: string;
      incident_id: string;
      operator_id: string;
      destination_url: string;
      payload: any;
      attempts: number;
    }> = [];

    try {
      await client.query('BEGIN');

      const claimQuery = `
        SELECT id, incident_id, operator_id, destination_url, payload, attempts
        FROM notification_outbox
        WHERE (
          (status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()))
          OR
          (status = 'in_flight' AND updated_at < NOW() - INTERVAL '30 seconds')
        )
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `;

      const res = await client.query(claimQuery, [this.config.OUTBOX_BATCH_SIZE]);
      records = res.rows;

      if (records.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      // Mark claimed records in_flight
      const ids = records.map((r) => r.id);
      await client.query(
        `UPDATE notification_outbox
         SET status = 'in_flight', updated_at = NOW()
         WHERE id = ANY($1)`,
        [ids]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Deliver each notification
    for (const record of records) {
      await this.deliverNotification(record);
    }

    return records.length;
  }

  private async deliverNotification(record: {
    id: string;
    incident_id: string;
    operator_id: string;
    destination_url: string;
    payload: any;
    attempts: number;
  }): Promise<void> {
    const cb = this.getCircuitBreaker(record.destination_url);

    let host = record.destination_url;
    try {
      host = new URL(record.destination_url).host;
    } catch {
      // fallback
    }

    if (!cb.canExecute()) {
      await this.persistCircuitBreakerState(host, cb);
      logger.warn(
        { host, destinationUrl: record.destination_url, recordId: record.id },
        'CircuitBreaker is OPEN: postponing outbox delivery'
      );

      await this.pool.query(
        `UPDATE notification_outbox
         SET status = 'failed',
             next_attempt_at = NOW() + INTERVAL '5 seconds',
             last_error = 'CircuitBreaker is OPEN: destination endpoint temporarily blocked',
             updated_at = NOW()
         WHERE id = $1`,
        [record.id]
      );
      return;
    }

    const timeoutMs = this.config.OUTBOX_TIMEOUT_MS || 5000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(record.destination_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APS-Outbox-Notifier/1.0',
          'Idempotency-Key': record.id,
        },
        body: JSON.stringify(record.payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }

      // Successful delivery
      cb.recordSuccess();
      await this.persistCircuitBreakerState(host, cb);

      await this.pool.query(
        `UPDATE notification_outbox
         SET status = 'sent',
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [record.id]
      );

      logger.info(
        { recordId: record.id, destinationUrl: record.destination_url },
        'Notification successfully delivered'
      );
    } catch (err: any) {
      clearTimeout(timeout);
      cb.recordFailure();
      await this.persistCircuitBreakerState(host, cb);

      const newAttempts = record.attempts + 1;
      const isDead = newAttempts >= this.config.MAX_OUTBOX_ATTEMPTS;
      const status = isDead ? 'dead' : 'failed';
      const errorMessage =
        err.name === 'AbortError'
          ? `Webhook request timed out after ${timeoutMs}ms`
          : err.message || 'Notification delivery failed';

      const delayMs = calculateBackoffWithJitter(newAttempts, 1000, 30000);

      await this.pool.query(
        `UPDATE notification_outbox
         SET status = $1,
             attempts = $2,
             next_attempt_at = NOW() + ($3 * interval '1 millisecond'),
             last_error = $4,
             updated_at = NOW()
         WHERE id = $5`,
        [status, newAttempts, delayMs, errorMessage, record.id]
      );

      logger.warn(
        {
          recordId: record.id,
          attempts: newAttempts,
          status,
          delayMs,
          error: errorMessage,
        },
        'Failed to deliver outbox notification'
      );
    }
  }

  /**
   * Resets dead notifications to 'pending' with attempts = 0 so they can be redelivered.
   */
  private async persistCircuitBreakerState(host: string, cb: CircuitBreaker): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO circuit_breaker_states (host, state, failure_count, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (host) DO UPDATE SET
           state = EXCLUDED.state,
           failure_count = EXCLUDED.failure_count,
           updated_at = NOW()`,
        [host, cb.getState(), cb.getConsecutiveFailures()]
      );
    } catch {
      // Non-critical background telemetry sync
    }
  }

  public async retryDeadNotifications(incidentId?: string): Promise<number> {
    let query = `
      UPDATE notification_outbox
      SET status = 'pending',
          attempts = 0,
          next_attempt_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
      WHERE status = 'dead'
    `;
    const params: any[] = [];
    if (incidentId) {
      params.push(incidentId);
      query += ' AND incident_id = $1';
    }
    query += ' RETURNING id';

    const res = await this.pool.query(query, params);
    logger.info({ count: res.rows.length, incidentId }, 'Retried dead notifications');
    return res.rows.length;
  }
}
