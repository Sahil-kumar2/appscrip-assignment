import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Rule, createLogger, emitChangeLog } from '@aps/shared';

const logger = createLogger({ service: 'incident-lifecycle' });

export interface ProcessedEvent {
  event_id: string;
  device_id: string;
  seq: number;
  ts: Date;
  received_at: Date;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface DeviceOperatorRecord {
  id: string;
  location_id: string | null;
  operator_id: string | null;
  webhook_url: string | null;
}

export interface IncidentMatchOutcome {
  incidentId: string;
  isNew: boolean;
  severity: string;
  occurrenceCount: number;
}

export class IncidentLifecycleService {
  /**
   * Automatically resolves any open or acknowledged absence incidents for a device
   * when it resumes transmitting telemetry.
   */
  public async resolveActiveAbsenceIncidents(
    client: pg.PoolClient,
    deviceId: string,
    eventId: string
  ): Promise<number> {
    const absenceIncRes = await client.query<{ id: string; status: string; rule_id: string }>(
      `SELECT i.id, i.status, i.rule_id
       FROM incidents i
       JOIN rules r ON r.id = i.rule_id
       WHERE i.device_id = $1
         AND r.rule_type = 'absence'
         AND i.status IN ('open', 'acknowledged')
       FOR UPDATE OF i`,
      [deviceId]
    );

    for (const inc of absenceIncRes.rows) {
      logger.info(
        { incidentId: inc.id, deviceId },
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
        [inc.id, inc.status, `Device resumed transmitting events (event_id: ${eventId})`]
      );

      await emitChangeLog(client, {
        entity: 'incident',
        entityId: inc.id,
        op: 'UPDATE',
        data: {
          incident_id: inc.id,
          status: 'auto_resolved',
          actor: 'device_resume',
        },
      });
    }

    return absenceIncRes.rows.length;
  }

  /**
   * Atomically creates a new incident or deduplicates to an existing open/acknowledged incident.
   * Attaches the trigger event, creates audit records, and queues an outbox notification on first occurrence.
   */
  public async handleRuleMatch(
    client: pg.PoolClient,
    rule: Rule,
    event: ProcessedEvent,
    device: DeviceOperatorRecord,
    matchReason: string
  ): Promise<IncidentMatchOutcome> {
    const dedupKey = `${rule.id}:${event.device_id}`;
    const newIncidentId = randomUUID();
    const summary = `Rule triggered: ${rule.name}. ${matchReason}`;
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
      [newIncidentId, dedupKey, rule.id, event.device_id, ruleSeverity, event.event_id, summary]
    );

    const {
      id: incidentId,
      is_new: isNew,
      severity,
      occurrence_count: occCount,
    } = upsertRes.rows[0];

    // Structured decision logging
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
          reason: `Rule ${rule.name} matched: ${matchReason}. Created new incident #${incidentId} (severity: ${ruleSeverity})`,
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
          reason: `Rule ${rule.name} matched: ${matchReason}. Suppressed new incident creation; incident #${incidentId} already open (count: ${occCount})`,
        },
        'Incident suppression decision: deduplicated to active incident'
      );
    }

    const severityEscalated = !isNew && ruleSeverity === 'critical' && severity === 'critical';

    // Link triggering event to incident_events (M:N)
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

      // Create transactional outbox notification for newly created incident
      if (device.operator_id && device.webhook_url) {
        const notificationId = randomUUID();
        const notificationPayload = {
          notification_id: notificationId,
          incident_id: incidentId,
          rule_name: rule.name,
          device_id: event.device_id,
          location_id: device.location_id,
          reason: matchReason,
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

      // Record change_log entry for newly opened incident
      await emitChangeLog(client, {
        entity: 'incident',
        entityId: incidentId,
        op: 'INSERT',
        data: {
          incident_id: incidentId,
          rule_id: rule.id,
          rule_name: rule.name,
          device_id: event.device_id,
          status: 'open',
          severity: ruleSeverity,
          summary,
          occurrence_count: 1,
        },
      });
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
            reason: `Escalation: ${matchReason}`,
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

      // Record change_log row for repeat match / update
      await emitChangeLog(client, {
        entity: 'incident',
        entityId: incidentId,
        op: 'UPDATE',
        data: {
          incident_id: incidentId,
          rule_id: rule.id,
          rule_name: rule.name,
          device_id: event.device_id,
          status: 'open',
          severity,
          occurrence_count: occCount,
          last_event_id: event.event_id,
        },
      });
    }

    return {
      incidentId,
      isNew,
      severity,
      occurrenceCount: occCount,
    };
  }
}
