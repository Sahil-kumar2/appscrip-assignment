import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(val: string): boolean {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

export interface ExplainRouteOptions {
  pool: pg.Pool;
}

export const explainRoutes: FastifyPluginAsync<ExplainRouteOptions> = async (fastify, opts) => {
  const { pool } = opts;

  fastify.get('/api/events/:id/explain', async (req, reply) => {
    const { id } = req.params as { id: string };

    if (!isValidUUID(id)) {
      return reply.code(400).send({ error: `Invalid event ID: '${id}'. Expected a valid UUID.` });
    }

    // Fetch the event
    const eventRes = await pool.query(
      `SELECT event_id, device_id, seq, ts, received_at, type, payload,
              schema_version, processing_status, attempts, last_error
       FROM events
       WHERE event_id = $1`,
      [id]
    );

    if (eventRes.rows.length === 0) {
      return reply.code(404).send({ error: `Event with id '${id}' not found` });
    }

    const event = eventRes.rows[0];

    // Fetch all rule evaluations for this event
    const evalRes = await pool.query<{
      id: string;
      event_id: string;
      rule_id: string;
      rule_name: string;
      rule_type: string;
      scope_type: string;
      rule_config: any;
      matched: boolean;
      reason: string;
      evaluated_at: string;
    }>(
      `SELECT re.id, re.event_id, re.rule_id, r.name as rule_name,
              r.rule_type, r.scope_type, r.config as rule_config,
              re.matched, re.reason, re.evaluated_at
       FROM rule_evaluations re
       LEFT JOIN rules r ON r.id = re.rule_id
       WHERE re.event_id = $1
       ORDER BY re.evaluated_at DESC`,
      [id]
    );

    // Also check if any incident is linked to this event
    const incidentRes = await pool.query<{
      id: string;
      dedup_key: string;
      rule_id: string;
      status: string;
      occurrence_count: number;
      first_seen_at: string;
      last_seen_at: string;
      summary: string;
      attached_at: string;
    }>(
      `SELECT i.id, i.dedup_key, i.rule_id, i.status, i.occurrence_count,
              i.first_seen_at, i.last_seen_at, i.summary, ie.attached_at
       FROM incident_events ie
       JOIN incidents i ON i.id = ie.incident_id
       WHERE ie.event_id = $1`,
      [id]
    );

    // Answer directly: "why did / didn't this create an incident?"
    const enrichedEvaluations = evalRes.rows.map((ev) => {
      const linkedIncident = incidentRes.rows.find((inc) => inc.rule_id === ev.rule_id);
      let decision: 'created' | 'suppressed' | 'not_matched' = 'not_matched';
      let decisionExplanation = ev.reason;

      if (ev.matched) {
        if (linkedIncident) {
          if (linkedIncident.occurrence_count <= 1) {
            decision = 'created';
            decisionExplanation = `Matched rule '${ev.rule_name || ev.rule_id}': created new incident #${linkedIncident.id} (status: ${linkedIncident.status}). ${ev.reason}`;
          } else {
            decision = 'suppressed';
            decisionExplanation = `Matched rule '${ev.rule_name || ev.rule_id}': suppressed, incident #${linkedIncident.id} already active (${linkedIncident.status}, count ${linkedIncident.occurrence_count}); event attached to existing incident. ${ev.reason}`;
          }
        } else {
          // If reason in DB already contains suppression text from worker
          if (ev.reason.includes('suppressed, incident')) {
            decision = 'suppressed';
            decisionExplanation = ev.reason;
          } else if (ev.reason.includes('created new incident')) {
            decision = 'created';
            decisionExplanation = ev.reason;
          } else {
            decision = 'created';
            decisionExplanation = `Matched rule '${ev.rule_name || ev.rule_id}'. ${ev.reason}`;
          }
        }
      } else {
        decision = 'not_matched';
        decisionExplanation = `Did not create incident: rule condition not met. ${ev.reason}`;
      }

      return {
        ...ev,
        decision,
        decision_explanation: decisionExplanation,
      };
    });

    const summaryParts = enrichedEvaluations.map((e) => e.decision_explanation);
    const summaryExplanation =
      summaryParts.length > 0
        ? summaryParts.join(' | ')
        : event.processing_status === 'pending'
          ? 'Event is pending in worker queue; rule evaluation has not executed yet'
          : 'No rules evaluated for this event';

    return {
      event,
      evaluations: enrichedEvaluations,
      triggered_incidents: incidentRes.rows,
      explanation_summary: summaryExplanation,
    };
  });
};
