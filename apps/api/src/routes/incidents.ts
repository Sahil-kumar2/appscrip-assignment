import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { withTransaction, createLogger } from '@aps/shared';

const logger = createLogger({ service: 'incident-routes' });

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(val: string): boolean {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

export interface IncidentRouteOptions {
  pool: pg.Pool;
}

export const incidentRoutes: FastifyPluginAsync<IncidentRouteOptions> = async (fastify, opts) => {
  const { pool } = opts;

  // List incidents with filters: status, severity, device/device_id
  fastify.get('/api/incidents', async (req) => {
    const query = req.query as {
      status?: string;
      severity?: string;
      device?: string;
      device_id?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
    const offset = Math.max(0, Number(query.offset || 0));

    const params: any[] = [];
    let sql = `
      SELECT i.*, r.name as rule_name, r.rule_type, d.name as device_name,
             (SELECT count(*) FROM incident_events ie WHERE ie.incident_id = i.id) as attached_events_count,
             COALESCE(
               (SELECT CASE WHEN no.status = 'delivered' THEN 'sent' ELSE no.status END
                FROM notification_outbox no
                WHERE no.incident_id = i.id
                ORDER BY no.created_at DESC
                LIMIT 1),
               'pending'
             ) as notification_status
      FROM incidents i
      JOIN rules r ON r.id = i.rule_id
      JOIN devices d ON d.id = i.device_id
      WHERE 1=1
    `;

    if (query.status) {
      params.push(query.status);
      sql += ` AND i.status = $${params.length}`;
    }

    if (query.severity) {
      params.push(query.severity);
      sql += ` AND i.severity = $${params.length}`;
    }

    const deviceFilter = query.device || query.device_id;
    if (deviceFilter) {
      params.push(deviceFilter);
      sql += ` AND i.device_id = $${params.length}`;
    }

    sql += ` ORDER BY i.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const res = await pool.query(sql, params);
    return { incidents: res.rows };
  });

  // Get incident detail with events, history, notification status, and rule evaluations
  fastify.get('/api/incidents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidUUID(id)) {
      return reply
        .code(400)
        .send({ error: `Invalid incident ID: '${id}'. Expected a valid UUID.` });
    }

    const incRes = await pool.query(
      `SELECT i.*, r.name as rule_name, r.rule_type, r.config as rule_config,
              d.name as device_name, d.location_id,
              COALESCE(
                (SELECT CASE WHEN no.status = 'delivered' THEN 'sent' ELSE no.status END
                 FROM notification_outbox no
                 WHERE no.incident_id = i.id
                 ORDER BY no.created_at DESC
                 LIMIT 1),
                'pending'
              ) as notification_status
       FROM incidents i
       JOIN rules r ON r.id = i.rule_id
       JOIN devices d ON d.id = i.device_id
       WHERE i.id = $1`,
      [id]
    );

    if (incRes.rows.length === 0) {
      return reply.code(404).send({ error: `Incident '${id}' not found` });
    }

    const incident = incRes.rows[0];

    // Attached events
    const eventsRes = await pool.query(
      `SELECT e.event_id, e.seq, e.ts, e.received_at, e.type, e.payload, ie.attached_at
       FROM incident_events ie
       JOIN events e ON e.event_id = ie.event_id
       WHERE ie.incident_id = $1
       ORDER BY ie.attached_at DESC
       LIMIT 50`,
      [id]
    );

    // Transition audit history
    const historyRes = await pool.query(
      `SELECT id, from_status, to_status, actor, timestamp, reason
       FROM incident_history
       WHERE incident_id = $1
       ORDER BY timestamp ASC`,
      [id]
    );

    // Outbox notification records
    const notificationsRes = await pool.query(
      `SELECT id, operator_id, destination_url, status, attempts, next_attempt_at, last_error, created_at, updated_at
       FROM notification_outbox
       WHERE incident_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    // Rule evaluations associated with this incident's events
    const ruleEvalRes = await pool.query(
      `SELECT re.id, re.event_id, re.rule_id, re.matched, re.reason, re.evaluated_at, r.name as rule_name
       FROM rule_evaluations re
       LEFT JOIN rules r ON r.id = re.rule_id
       WHERE re.event_id IN (
         SELECT ie.event_id FROM incident_events ie WHERE ie.incident_id = $1
       )
       ORDER BY re.evaluated_at DESC
       LIMIT 50`,
      [id]
    );

    const enrichedRuleEvaluations = ruleEvalRes.rows.map((re) => {
      let decision = 'not_matched';
      let decisionExplanation = `Did not create incident: rule condition not met. ${re.reason}`;

      if (re.matched) {
        if (incident.occurrence_count <= 1) {
          decision = 'created';
          decisionExplanation = `Matched rule '${re.rule_name || re.rule_id}': created incident #${incident.id}. ${re.reason}`;
        } else {
          decision = 'suppressed';
          decisionExplanation = `Matched rule '${re.rule_name || re.rule_id}': suppressed duplicate creation; attached to active incident #${incident.id} (occurrence count: ${incident.occurrence_count}). ${re.reason}`;
        }
      }

      return {
        ...re,
        decision,
        decision_explanation: decisionExplanation,
      };
    });

    return {
      incident,
      events: eventsRes.rows,
      history: historyRes.rows,
      notifications: notificationsRes.rows,
      rule_evaluations: enrichedRuleEvaluations,
    };
  });

  // Acknowledge incident (idempotent, 409 on invalid transition, recorded with actor)
  const handleAcknowledge = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    if (!isValidUUID(id)) {
      return reply
        .code(400)
        .send({ error: `Invalid incident ID: '${id}'. Expected a valid UUID.` });
    }
    const body = (req.body as { actor?: string; reason?: string }) || {};
    const actor = body.actor || 'operator';
    const reason = body.reason || 'Operator acknowledged incident';

    const result = await withTransaction(pool, async (client) => {
      const incRes = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM incidents WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (incRes.rows.length === 0) {
        return { error: `Incident '${id}' not found`, code: 404 };
      }

      const current = incRes.rows[0];

      // Idempotent: already acknowledged
      if (current.status === 'acknowledged') {
        return {
          idempotent: true,
          status: 'acknowledged',
          incident_id: id,
          message: 'Incident is already acknowledged',
        };
      }

      // Invalid transition: cannot acknowledge a resolved incident
      if (current.status === 'resolved' || current.status === 'auto_resolved') {
        return {
          error: `Cannot acknowledge incident in '${current.status}' status. Only open incidents can be acknowledged.`,
          code: 409,
        };
      }

      if (current.status !== 'open') {
        return {
          error: `Invalid transition: cannot acknowledge incident from '${current.status}'.`,
          code: 409,
        };
      }

      // Transition open -> acknowledged
      await client.query(
        `UPDATE incidents
         SET status = 'acknowledged', acknowledged_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      // Audit history
      await client.query(
        `INSERT INTO incident_history (incident_id, from_status, to_status, actor, reason)
         VALUES ($1, $2, 'acknowledged', $3, $4)`,
        [id, current.status, actor, reason]
      );

      // Change log
      await client.query(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('incident', $1, 'UPDATE', $2::jsonb)`,
        [
          id,
          JSON.stringify({
            incident_id: id,
            status: 'acknowledged',
            actor,
          }),
        ]
      );

      return { status: 'acknowledged', incident_id: id, actor };
    });

    if ('error' in result) {
      return reply.code(result.code ?? 400).send({ error: result.error });
    }

    logger.info({ incidentId: id, actor }, 'Incident acknowledged');
    return result;
  };

  fastify.post('/api/incidents/:id/ack', handleAcknowledge);
  fastify.post('/api/incidents/:id/acknowledge', handleAcknowledge);

  // Resolve incident (idempotent, 409 on invalid transition, recorded with actor)
  fastify.post('/api/incidents/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidUUID(id)) {
      return reply
        .code(400)
        .send({ error: `Invalid incident ID: '${id}'. Expected a valid UUID.` });
    }
    const body = (req.body as { actor?: string; reason?: string }) || {};
    const actor = body.actor || 'operator';
    const reason = body.reason || 'Operator resolved incident';

    const result = await withTransaction(pool, async (client) => {
      const incRes = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM incidents WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (incRes.rows.length === 0) {
        return { error: `Incident '${id}' not found`, code: 404 };
      }

      const current = incRes.rows[0];

      // Idempotent: already resolved
      if (current.status === 'resolved') {
        return {
          idempotent: true,
          status: 'resolved',
          incident_id: id,
          message: 'Incident is already resolved',
        };
      }

      if (current.status === 'auto_resolved') {
        return {
          error:
            "Cannot resolve incident in 'auto_resolved' status. It has already been automatically resolved.",
          code: 409,
        };
      }

      // Valid transitions: open -> resolved OR acknowledged -> resolved
      if (current.status !== 'open' && current.status !== 'acknowledged') {
        return {
          error: `Invalid transition: cannot resolve incident in '${current.status}' status.`,
          code: 409,
        };
      }

      // Update incident
      await client.query(
        `UPDATE incidents
         SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      // Audit history
      await client.query(
        `INSERT INTO incident_history (incident_id, from_status, to_status, actor, reason)
         VALUES ($1, $2, 'resolved', $3, $4)`,
        [id, current.status, actor, reason]
      );

      // Change log
      await client.query(
        `INSERT INTO change_log (entity, entity_id, op, data)
         VALUES ('incident', $1, 'UPDATE', $2::jsonb)`,
        [
          id,
          JSON.stringify({
            incident_id: id,
            status: 'resolved',
            actor,
          }),
        ]
      );

      return { status: 'resolved', incident_id: id, actor };
    });

    if ('error' in result) {
      return reply.code(result.code ?? 400).send({ error: result.error });
    }

    logger.info({ incidentId: id, actor }, 'Incident resolved');
    return result;
  });

  // Retry dead/failed notifications for this specific incident
  fastify.post('/api/incidents/:id/retry-notifications', async (req, reply) => {
    const { id } = req.params as { id: string };

    const checkRes = await pool.query('SELECT id FROM incidents WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ error: `Incident '${id}' not found` });
    }

    const res = await pool.query(
      `UPDATE notification_outbox
       SET status = 'pending',
           attempts = 0,
           next_attempt_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE incident_id = $1 AND status IN ('dead', 'failed')
       RETURNING id`,
      [id]
    );

    logger.info(
      { incidentId: id, retriedCount: res.rows.length },
      'Retried dead notifications for incident'
    );
    return {
      success: true,
      incident_id: id,
      retried_count: res.rows.length,
      retried_ids: res.rows.map((r) => r.id),
    };
  });
};
