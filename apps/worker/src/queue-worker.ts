import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createLogger, withTransaction } from '@aps/shared';
import { WorkerConfig } from './config.js';
import { evaluateRule, RuleCache } from './rule-engine.js';

const logger = createLogger({ service: 'queue-worker' });

export class QueueWorker {
  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private inFlightBatch: Promise<number> | null = null;
  private readonly pool: pg.Pool;
  private readonly config: WorkerConfig;
  private readonly ruleCache: RuleCache;

  constructor(pool: pg.Pool, config: WorkerConfig) {
    this.pool = pool;
    this.config = config;
    this.ruleCache = new RuleCache(5000); // 5s TTL rule cache
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
        const devRes = await client.query<{
          id: string;
          location_id: string;
          operator_id: string | null;
          webhook_url: string | null;
        }>(
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
        const absenceIncRes = await client.query<{ id: string; status: string; rule_id: string }>(
          `SELECT i.id, i.status, i.rule_id
           FROM incidents i
           JOIN rules r ON r.id = i.rule_id
           WHERE i.device_id = $1
             AND r.rule_type = 'absence'
             AND i.status IN ('open', 'acknowledged')
           FOR UPDATE OF i`,
          [event.device_id]
        );

        for (const inc of absenceIncRes.rows) {
          logger.info(
            { incidentId: inc.id, deviceId: event.device_id },
            'Auto-resolving absence incident as device reported again'
          );

          await client.query(
            `UPDATE incidents
             SET status = 'auto_resolved', updated_at = NOW()
             WHERE id = $1`,
            [inc.id]
          );

          await client.query(
            `INSERT INTO incident_history (incident_id, from_status, to_status, actor, reason)
             VALUES ($1, $2, 'auto_resolved', 'device_resume', $3)`,
            [inc.id, inc.status, `Device resumed transmitting events (event_id: ${event.event_id})`]
          );

          await client.query(
            `INSERT INTO change_log (entity, entity_id, op, data)
             VALUES ('incident', $1, 'UPDATE', $2::jsonb)`,
            [
              inc.id,
              JSON.stringify({
                incident_id: inc.id,
                status: 'auto_resolved',
                actor: 'device_resume',
              }),
            ]
          );
        }

        // 3. Fetch active rules (from cached enabled rules)
        const rules = await this.ruleCache.getEnabledRules(client);

        // 4. Evaluate rules
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

          // Rule matched! Dedup key = rule_id:device_id
          const dedupKey = `${rule.id}:${event.device_id}`;
          const newIncidentId = randomUUID();
          const summary = `Rule triggered: ${rule.name}. ${evalResult.reason}`;
          const ruleSeverity = (rule as any).severity || 'warning';

          // Atomic upsert on partial unique index: ON CONFLICT (dedup_key) WHERE status IN ('open', 'acknowledged')
          const upsertRes = await client.query<{
            id: string;
            is_new: boolean;
            severity: string;
            occurrence_count: number;
          }>(
            `INSERT INTO incidents (
               id, dedup_key, rule_id, device_id, status, severity,
               opened_at, first_seen_at, last_seen_at, last_event_at, last_event_id,
               occurrence_count, summary
             )
             VALUES ($1, $2, $3, $4, 'open', $5, NOW(), NOW(), NOW(), NOW(), $6, 1, $7)
             ON CONFLICT (dedup_key) WHERE status IN ('open', 'acknowledged')
             DO UPDATE SET
               occurrence_count = incidents.occurrence_count + 1,
               last_seen_at = NOW(),
               last_event_at = NOW(),
               last_event_id = EXCLUDED.last_event_id,
               updated_at = NOW(),
               severity = CASE 
                 WHEN EXCLUDED.severity = 'critical' AND incidents.severity != 'critical' THEN 'critical'
                 ELSE incidents.severity
               END
             RETURNING 
               id,
               (xmax = 0) AS is_new,
               severity,
               occurrence_count`,
            [
              newIncidentId,
              dedupKey,
              rule.id,
              event.device_id,
              ruleSeverity,
              event.event_id,
              summary,
            ]
          );

          const {
            id: incidentId,
            is_new: isNew,
            severity,
            occurrence_count: occCount,
          } = upsertRes.rows[0];

          // Log every incident creation or suppression decision with exact fields
          if (isNew) {
            logger.info(
              {
                event_id: event.event_id,
                incident_id: incidentId,
                rule_id: rule.id,
                device_id: event.device_id,
                decision: 'created',
                severity: ruleSeverity,
                occurrence_count: 1,
                reason: `Rule ${rule.name} matched: ${evalResult.reason}. Created new incident #${incidentId} (severity: ${ruleSeverity})`,
              },
              'Incident creation decision: created new incident'
            );
          } else {
            logger.info(
              {
                event_id: event.event_id,
                incident_id: incidentId,
                rule_id: rule.id,
                device_id: event.device_id,
                decision: 'suppressed',
                occurrence_count: occCount,
                reason: `Rule ${rule.name} matched: ${evalResult.reason}. Suppressed new incident creation; incident #${incidentId} already open (count: ${occCount})`,
              },
              'Incident suppression decision: deduplicated to active incident'
            );
          }

          const severityEscalated =
            !isNew && ruleSeverity === 'critical' && severity === 'critical';

          // Link triggering event to incident_events
          await client.query(
            `INSERT INTO incident_events (incident_id, event_id)
             VALUES ($1, $2)
             ON CONFLICT (incident_id, event_id) DO NOTHING`,
            [incidentId, event.event_id]
          );

          if (isNew) {
            // Initial incident history entry
            await client.query(
              `INSERT INTO incident_history (incident_id, from_status, to_status, actor, reason)
               VALUES ($1, NULL, 'open', 'system', $2)`,
              [incidentId, summary]
            );

            // Change log insert
            await client.query(
              `INSERT INTO change_log (entity, entity_id, op, data)
               VALUES ('incident', $1, 'INSERT', $2::jsonb)`,
              [
                incidentId,
                JSON.stringify({
                  incident_id: incidentId,
                  rule_id: rule.id,
                  rule_name: rule.name,
                  device_id: event.device_id,
                  status: 'open',
                  severity: ruleSeverity,
                  occurrence_count: 1,
                }),
              ]
            );

            // Notification Outbox for newly created incident
            if (device.operator_id && device.webhook_url) {
              const notificationId = randomUUID();
              const notificationPayload = {
                notification_id: notificationId,
                incident_id: incidentId,
                rule_name: rule.name,
                device_id: event.device_id,
                location_id: device.location_id,
                reason: evalResult.reason,
                event_id: event.event_id,
                severity: ruleSeverity,
                timestamp: new Date().toISOString(),
              };

              await client.query(
                `INSERT INTO notification_outbox (
                   id, incident_id, operator_id, destination_url, payload,
                   status, attempts, next_attempt_at
                 )
                 VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, NOW())`,
                [
                  notificationId,
                  incidentId,
                  device.operator_id,
                  device.webhook_url,
                  JSON.stringify(notificationPayload),
                ]
              );

              logger.info(
                { incidentId, notificationId, operatorId: device.operator_id },
                'Created transactional outbox notification'
              );
            }
          } else {
            // Repeat match: bump occurrence_count
            logger.info(
              { incidentId, dedupKey, eventId: event.event_id, occurrenceCount: occCount },
              'Incremented occurrence count on active incident'
            );

            // If severity escalated, record history and outbox
            if (severityEscalated) {
              await client.query(
                `INSERT INTO incident_history (incident_id, from_status, to_status, actor, reason)
                 VALUES ($1, 'open', 'open', 'system', $2)`,
                [incidentId, 'Severity escalated to critical']
              );

              if (device.operator_id && device.webhook_url) {
                const notificationId = randomUUID();
                const notificationPayload = {
                  notification_id: notificationId,
                  incident_id: incidentId,
                  rule_name: rule.name,
                  device_id: event.device_id,
                  location_id: device.location_id,
                  reason: `Escalation: ${evalResult.reason}`,
                  event_id: event.event_id,
                  severity: 'critical',
                  timestamp: new Date().toISOString(),
                };

                await client.query(
                  `INSERT INTO notification_outbox (
                     id, incident_id, operator_id, destination_url, payload,
                     status, attempts, next_attempt_at
                   )
                   VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, NOW())`,
                  [
                    notificationId,
                    incidentId,
                    device.operator_id,
                    device.webhook_url,
                    JSON.stringify(notificationPayload),
                  ]
                );
              }
            }

            // Write change_log row for repeat match / update
            await client.query(
              `INSERT INTO change_log (entity, entity_id, op, data)
               VALUES ('incident', $1, 'UPDATE', $2::jsonb)`,
              [
                incidentId,
                JSON.stringify({
                  incident_id: incidentId,
                  occurrence_count: occCount,
                  last_event_id: event.event_id,
                  severity_escalated: severityEscalated,
                }),
              ]
            );
          }
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
      const nextStatus = isDeadLetter ? 'failed' : 'pending';
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
