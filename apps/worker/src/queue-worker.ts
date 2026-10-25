import pg from 'pg';
import { createLogger, withTransaction } from '@aps/shared';
import { WorkerConfig } from './config.js';
import { evaluateRule, RuleCache } from './rule-engine.js';
import {
  IncidentLifecycleService,
  ProcessedEvent,
  DeviceOperatorRecord,
} from './services/incident-lifecycle.service.js';

const logger = createLogger({ service: 'queue-worker' });

export class QueueWorker {
  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private inFlightBatch: Promise<number> | null = null;
  private readonly pool: pg.Pool;
  private readonly config: WorkerConfig;
  private readonly ruleCache: RuleCache;
  private readonly incidentLifecycle: IncidentLifecycleService;

  constructor(pool: pg.Pool, config: WorkerConfig) {
    this.pool = pool;
    this.config = config;
    this.ruleCache = new RuleCache(5000); // 5s TTL rule cache
    this.incidentLifecycle = new IncidentLifecycleService();
  }

  public invalidateRuleCache(): void {
    this.ruleCache.invalidate();
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('QueueWorker started');
    this.scheduleNext(0);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.inFlightBatch) {
      logger.info('Waiting for in-flight batch to finish before stopping QueueWorker...');
      try {
        await this.inFlightBatch;
      } catch {
        // Ignore in-flight errors during shutdown
      }
    }
    logger.info('QueueWorker stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.loopTimer = setTimeout(async () => {
      if (!this.isRunning) return;
      try {
        this.inFlightBatch = this.processBatch();
        const processedCount = await this.inFlightBatch;
        // If we processed a full batch, poll again immediately, otherwise back off by poll interval
        const nextDelay =
          processedCount >= this.config.WORKER_BATCH_SIZE ? 0 : this.config.WORKER_POLL_INTERVAL_MS;
        this.scheduleNext(nextDelay);
      } catch (err) {
        logger.error({ err }, 'Error in queue worker iteration');
        this.scheduleNext(this.config.WORKER_POLL_INTERVAL_MS);
      } finally {
        this.inFlightBatch = null;
      }
    }, delayMs);
  }

  /**
   * Claims up to N pending events using SELECT ... FOR UPDATE SKIP LOCKED.
   * Sets processing_status = 'processing' and locked_until = NOW() + lease.
   * Also reclaims rows whose lease expired.
   */
  public async processBatch(): Promise<number> {
    const client = await this.pool.connect();
    let claimedEvents: Array<{
      event_id: string;
      device_id: string;
      seq: number;
      ts: Date;
      received_at: Date;
      type: string;
      payload: any;
      attempts: number;
    }> = [];

    try {
      await client.query('BEGIN');

      // Claim events with FOR UPDATE SKIP LOCKED and apply lease
      const claimQuery = `
        SELECT event_id, device_id, seq, ts, received_at, type, payload, attempts
        FROM events
        WHERE (processing_status = 'pending' AND (locked_until IS NULL OR locked_until <= NOW()))
           OR (processing_status = 'processing' AND locked_until < NOW())
        ORDER BY received_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `;

      const claimRes = await client.query(claimQuery, [this.config.WORKER_BATCH_SIZE]);
      claimedEvents = claimRes.rows;

      if (claimedEvents.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const eventIds = claimedEvents.map((e) => e.event_id);
      await client.query(
        `UPDATE events
         SET processing_status = 'processing',
             locked_until = NOW() + ($1 * interval '1 second')
         WHERE event_id = ANY($2)`,
        [this.config.EVENT_LEASE_SECONDS, eventIds]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Process each event in its own transaction for atomic completion and failure isolation
    for (const event of claimedEvents) {
      await this.processSingleEvent(event);
    }

    return claimedEvents.length;
  }

  public async processSingleEvent(event: {
    event_id: string;
    device_id: string;
    seq: number;
    ts: Date;
    received_at: Date;
    type: string;
    payload: any;
    attempts: number;
    locked_until?: Date | null;
  }): Promise<void> {
    try {
      await withTransaction(this.pool, async (client) => {
        // 1. Fetch Device & Assigned Operator
        const devRes = await client.query<DeviceOperatorRecord>(
          `SELECT d.id, d.location_id, o.id as operator_id, o.webhook_url
           FROM devices d
           LEFT JOIN operators o ON (o.location_id = d.location_id OR d.location_id = ANY(o.location_ids))
           WHERE d.id = $1`,
          [event.device_id]
        );

        const device = devRes.rows[0] || {
          id: event.device_id,
          location_id: null,
          operator_id: null,
          webhook_url: null,
        };

        // 2. Auto-resolve active absence incidents if device has resumed reporting
        await this.incidentLifecycle.resolveActiveAbsenceIncidents(
          client,
          event.device_id,
          event.event_id
        );

        // 3. Fetch active rules (from cached enabled rules)
        const rules = await this.ruleCache.getEnabledRules(client);

        // 4. Evaluate rules
        const processedEv: ProcessedEvent = {
          event_id: event.event_id,
          device_id: event.device_id,
          seq: event.seq,
          ts: event.ts,
          received_at: event.received_at,
          type: event.type,
          payload: event.payload,
          attempts: event.attempts,
        };

        for (const rule of rules) {
          const evalResult = evaluateRule(rule, event, device);

          // Store rule evaluation row for explainability
          await client.query(
            `INSERT INTO rule_evaluations (event_id, rule_id, matched, reason)
             VALUES ($1, $2, $3, $4)`,
            [event.event_id, rule.id, evalResult.matched, evalResult.reason]
          );

          if (!evalResult.matched) {
            logger.debug(
              {
                event_id: event.event_id,
                rule_id: rule.id,
                device_id: event.device_id,
                decision: 'not_matched',
                reason: evalResult.reason,
              },
              'Rule evaluation condition not met: no incident created'
            );
            continue;
          }

          // Rule matched: delegate to incidentLifecycle manager
          await this.incidentLifecycle.handleRuleMatch(
            client,
            rule,
            processedEv,
            device,
            evalResult.reason
          );
        }

        // 5. Mark event as done in the SAME transaction with lease fencing.
        // Fencing prevents zombie workers whose lease expired from committing
        // duplicate mutations.
        const updateRes = await client.query(
          `UPDATE events
           SET processing_status = 'done', locked_until = NULL, last_error = NULL
           WHERE event_id = $1
             AND (locked_until IS NULL OR locked_until >= NOW())`,
          [event.event_id]
        );

        if (updateRes.rowCount === 0) {
          throw new Error(
            `Lease expired for event ${event.event_id} before transaction completion; aborting to prevent duplicate mutations`
          );
        }
      });
    } catch (err: any) {
      logger.error(
        { err, eventId: event.event_id, attempts: event.attempts },
        'Failed to process event'
      );

      const newAttempts = event.attempts + 1;
      const isDeadLetter = newAttempts >= this.config.MAX_EVENT_ATTEMPTS;
      const backoffSec = Math.min(300, Math.pow(2, newAttempts)); // Exponential backoff capped at 5 minutes

      try {
        if (isDeadLetter) {
          await this.pool.query(
            `UPDATE events
             SET processing_status = 'failed',
                 attempts = $1,
                 locked_until = NULL,
                 last_error = $2
             WHERE event_id = $3`,
            [newAttempts, err.message || String(err), event.event_id]
          );
        } else {
          await this.pool.query(
            `UPDATE events
             SET processing_status = 'pending',
                 attempts = $1,
                 locked_until = NOW() + ($2 * interval '1 second'),
                 last_error = $3
             WHERE event_id = $4`,
            [newAttempts, backoffSec, err.message || String(err), event.event_id]
          );
        }
      } catch (updateErr) {
        logger.error({ updateErr }, 'Failed to record event error state');
      }
    }
  }
}
