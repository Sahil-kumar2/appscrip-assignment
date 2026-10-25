import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Rule, createLogger, withTransaction } from '@aps/shared';
import { WorkerConfig } from './config.js';

const logger = createLogger({ service: 'absence-monitor' });
const ADVISORY_LOCK_ID = 778899;

export class AbsenceMonitor {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly pool: pg.Pool;
  private readonly config: WorkerConfig;

  constructor(pool: pg.Pool, config: WorkerConfig) {
    this.pool = pool;
    this.config = config;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('AbsenceMonitor started');
    this.scheduleNext(0);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('AbsenceMonitor stopped');
  }

  private scheduleNext(delayMs: number): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      if (!this.isRunning) return;
      try {
        await this.runIteration();
      } catch (err) {
        logger.error({ err }, 'Error in absence monitor iteration');
      } finally {
        this.scheduleNext(this.config.ABSENCE_CHECK_INTERVAL_MS);
      }
    }, delayMs);
  }

  /**
   * Runs an iteration guarded by an advisory lock so only one leader worker
   * across multiple replicas evaluates absence rules and derives device statuses.
   */
  public async runIteration(): Promise<{ absencesTriggered: number; statusTransitions: number }> {
    const client = await this.pool.connect();
    try {
      // 1. Leader election via pg_try_advisory_lock
      const lockRes = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) as locked',
        [ADVISORY_LOCK_ID]
      );

      if (!lockRes.rows[0]?.locked) {
        logger.debug('Another worker is currently the absence monitor leader, skipping iteration');
        return { absencesTriggered: 0, statusTransitions: 0 };
      }

      try {
        // 2. Derive device statuses (online/stale/offline/unknown) and record transitions in change_log
        const statusTransitions = await this.updateDerivedDeviceStatuses(client);

        // 3. Evaluate absence rules
        const absencesTriggered = await this.checkAbsences(client);

        return { absencesTriggered, statusTransitions };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Derives device status based on elapsed time since last_seen_at:
   * - online:  <= 30s
   * - stale:   > 30s and <= 60s
   * - offline: > 60s
   * - unknown: never seen (last_seen_at IS NULL)
   * Emits a change_log row on each status transition.
   */
  public async updateDerivedDeviceStatuses(client: pg.PoolClient): Promise<number> {
    const devRes = await client.query<{ id: string; status: string; last_seen_at: Date | null }>(
      'SELECT id, status, last_seen_at FROM devices'
    );

    const now = Date.now();
    let transitionCount = 0;

    for (const dev of devRes.rows) {
      let derivedStatus: 'online' | 'stale' | 'offline' | 'unknown';

      if (!dev.last_seen_at) {
        derivedStatus = 'unknown';
      } else {
        const elapsedSec = (now - new Date(dev.last_seen_at).getTime()) / 1000;
        if (elapsedSec <= 30) {
          derivedStatus = 'online';
        } else if (elapsedSec <= 60) {
          derivedStatus = 'stale';
        } else {
          derivedStatus = 'offline';
        }
      }

      if (dev.status !== derivedStatus) {
        await client.query('UPDATE devices SET status = $1 WHERE id = $2', [derivedStatus, dev.id]);

        await client.query(
          `INSERT INTO change_log (entity, entity_id, op, data)
           VALUES ('device', $1, 'UPDATE', $2::jsonb)`,
          [
            dev.id,
            JSON.stringify({
              device_id: dev.id,
              from_status: dev.status,
              to_status: derivedStatus,
            }),
          ]
        );

        logger.info(
          { deviceId: dev.id, fromStatus: dev.status, toStatus: derivedStatus },
          'Device status derived and transitioned'
        );
        transitionCount++;
      }
    }

    return transitionCount;
  }

  /**
   * Evaluates enabled absence rules and creates an incident for devices that have not
   * reported heartbeats within the rule's timeout threshold.
   */
  public async checkAbsences(client: pg.PoolClient): Promise<number> {
    // 1. Fetch enabled absence rules
    const rulesRes = await client.query<Rule>(
      "SELECT * FROM rules WHERE enabled = true AND (rule_type = 'absence' OR type = 'absence')"
    );
    const absenceRules = rulesRes.rows;
    if (absenceRules.length === 0) return 0;

    let triggeredCount = 0;

    for (const rule of absenceRules) {
      const timeoutSec = Number(rule.config.timeout_seconds || 60);

      // Find candidate devices in scope whose last_seen_at is older than timeoutSec
      let deviceQuery = `
        SELECT d.id, d.name, d.location_id, d.status, d.last_seen_at,
               o.id as operator_id, o.webhook_url
        FROM devices d
        LEFT JOIN operators o ON (o.location_id = d.location_id OR d.location_id = ANY(o.location_ids))
        WHERE (
          (d.last_seen_at IS NOT NULL AND d.last_seen_at < NOW() - ($1 * interval '1 second'))
          OR
          (d.last_seen_at IS NULL AND d.created_at < NOW() - ($1 * interval '1 second'))
        )
      `;
      const params: any[] = [timeoutSec];

      const scopeType = rule.scope_type || (rule as any).scope?.type;
      const scopeVal = rule.scope_value || (rule as any).scope?.value;

      if (scopeType === 'device' && scopeVal) {
        params.push(scopeVal);
        deviceQuery += ` AND d.id = $${params.length}`;
      } else if (scopeType === 'location' && scopeVal) {
        params.push(scopeVal);
        deviceQuery += ` AND d.location_id = $${params.length}`;
      }

      const devicesRes = await client.query(deviceQuery, params);

      for (const device of devicesRes.rows) {
        const dedupKey = `${rule.id}:${device.id}`;

        const triggered = await withTransaction(this.pool, async (txClient) => {
          // Re-verify that the device is still absent using a fresh row read
          const freshDevRes = await txClient.query<{
            last_seen_at: Date | null;
            created_at: Date;
          }>('SELECT last_seen_at, created_at FROM devices WHERE id = $1', [device.id]);
          if (freshDevRes.rows.length === 0) return false;
          const freshDev = freshDevRes.rows[0];
          const lastActivity = freshDev.last_seen_at || freshDev.created_at;
          const elapsedMs = Date.now() - new Date(lastActivity).getTime();
          if (elapsedMs < timeoutSec * 1000) {
            // Device reported in the interim race window; do not trigger false absence
            return false;
          }

          // Check if active incident already exists
          const existing = await txClient.query(
            "SELECT id FROM incidents WHERE dedup_key = $1 AND status IN ('open', 'acknowledged') FOR UPDATE",
            [dedupKey]
          );

          if (existing.rows.length > 0) {
            // Already has an active open or acknowledged incident
            logger.info(
              {
                incident_id: existing.rows[0].id,
                rule_id: rule.id,
                device_id: device.id,
                decision: 'suppressed',
                timeoutSec,
                reason: `Device ${device.id} absent (> ${timeoutSec}s), but incident #${existing.rows[0].id} is already open/acknowledged; suppressed duplicate creation`,
              },
              'Absence incident suppression decision: active incident already exists'
            );
            return false;
          }

          // Trigger new absence incident with ON CONFLICT guard on partial unique index
          const incidentId = randomUUID();
          const summary = `Device heartbeat absent for > ${timeoutSec}s`;
          const severity = (rule as any).severity || 'warning';

          const insertRes = await txClient.query<{ id: string }>(
            `INSERT INTO incidents (
               id, dedup_key, rule_id, device_id, status, severity,
               opened_at, first_seen_at, last_seen_at, last_event_at,
               occurrence_count, summary
             )
             VALUES ($1, $2, $3, $4, 'open', $5, NOW(), NOW(), NOW(), NOW(), 1, $6)
             ON CONFLICT (dedup_key) WHERE status IN ('open', 'acknowledged') DO NOTHING
             RETURNING id`,
            [incidentId, dedupKey, rule.id, device.id, severity, summary]
          );

          if (insertRes.rows.length === 0) {
            return false;
          }

          // Update device status to offline
          await txClient.query("UPDATE devices SET status = 'offline' WHERE id = $1", [device.id]);

          // Incident audit history
          await txClient.query(
            `INSERT INTO incident_history (incident_id, from_status, to_status, actor, reason)
             VALUES ($1, NULL, 'open', 'absence_monitor', $2)`,
            [incidentId, `Device has not reported heartbeat for more than ${timeoutSec} seconds.`]
          );

          // Change log
          await txClient.query(
            `INSERT INTO change_log (entity, entity_id, op, data)
             VALUES ('incident', $1, 'INSERT', $2::jsonb)`,
            [
              incidentId,
              JSON.stringify({
                incident_id: incidentId,
                rule_id: rule.id,
                device_id: device.id,
                status: 'open',
                reason: 'device_absence',
              }),
            ]
          );

          // Transactional Outbox notification to operator
          if (device.operator_id && device.webhook_url) {
            const notificationId = randomUUID();
            const notificationPayload = {
              notification_id: notificationId,
              incident_id: incidentId,
              rule_name: rule.name,
              device_id: device.id,
              location_id: device.location_id,
              reason: `Device heartbeat absent for > ${timeoutSec} seconds`,
              severity,
              timestamp: new Date().toISOString(),
            };

            await txClient.query(
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

          return true;
        });

        if (triggered) {
          triggeredCount++;
          logger.warn(
            {
              rule_id: rule.id,
              device_id: device.id,
              decision: 'created',
              timeoutSec,
              reason: `Device heartbeat absent for > ${timeoutSec}s. Created new absence incident`,
            },
            'Absence incident creation decision: created new absence incident'
          );
        }
      }
    }

    return triggeredCount;
  }
}
