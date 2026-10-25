import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import {
  register,
  queueDepthGauge,
  incidentsGauge,
  incidentsByStateGauge,
  outboxByStatusGauge,
  eventProcessingAttemptsGauge,
  eventProcessingFailuresGauge,
  sseActiveClientsGauge,
  circuitBreakerStateGauge,
} from '../metrics.js';
import { getActiveSSEClientCount } from './stream.js';

export interface ObservabilityRouteOptions {
  pool: pg.Pool;
}

export const observabilityRoutes: FastifyPluginAsync<ObservabilityRouteOptions> = async (
  fastify,
  opts
) => {
  const { pool } = opts;

  // Liveness check
  fastify.get('/healthz', async () => {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  });

  // Readiness check: DB connectivity + migrations applied + queue lag below threshold
  fastify.get('/readyz', async (req, reply) => {
    try {
      // 1. DB ping
      await pool.query('SELECT 1');

      // 2. Migrations check
      const migRes = await pool.query<{ count: string }>(
        `SELECT count(*) as count FROM schema_migrations`
      );
      const appliedCount = Number(migRes.rows[0]?.count || 0);
      if (appliedCount === 0) {
        reply.code(503);
        return {
          status: 'not_ready',
          error: 'No database migrations applied',
        };
      }

      // 3. Queue lag metrics
      const queueRes = await pool.query<{
        pending_count: string;
        oldest_pending_age_seconds: string;
      }>(`
        SELECT count(*) as pending_count,
               COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(received_at))), 0) as oldest_pending_age_seconds
        FROM events
        WHERE processing_status = 'pending'
      `);

      const pendingCount = Number(queueRes.rows[0]?.pending_count || 0);
      const oldestPendingAge = Math.round(
        Number(queueRes.rows[0]?.oldest_pending_age_seconds || 0)
      );

      const maxLagSeconds = parseInt(process.env.QUEUE_LAG_READY_THRESHOLD_SEC || '120', 10);
      const maxPending = parseInt(process.env.QUEUE_PENDING_READY_THRESHOLD || '5000', 10);

      if (pendingCount > 0 && oldestPendingAge > maxLagSeconds) {
        reply.code(503);
        return {
          status: 'not_ready',
          error: `Queue lag exceeded threshold (${oldestPendingAge}s > ${maxLagSeconds}s)`,
          queue_lag: {
            pending_count: pendingCount,
            oldest_pending_age_seconds: oldestPendingAge,
            threshold_seconds: maxLagSeconds,
          },
        };
      }

      if (pendingCount > maxPending) {
        reply.code(503);
        return {
          status: 'not_ready',
          error: `Queue pending depth exceeded threshold (${pendingCount} > ${maxPending})`,
          queue_lag: {
            pending_count: pendingCount,
            oldest_pending_age_seconds: oldestPendingAge,
          },
        };
      }

      // 4. Outbox pending count
      const outboxRes = await pool.query<{ count: string }>(
        "SELECT count(*) as count FROM notification_outbox WHERE status IN ('pending', 'failed')"
      );
      const pendingOutbox = Number(outboxRes.rows[0]?.count || 0);

      // Update gauges for Prometheus
      queueDepthGauge.set({ status: 'pending' }, pendingCount);

      return {
        status: 'ready',
        db: 'connected',
        migrations: {
          applied: true,
          count: appliedCount,
        },
        queue_lag: {
          pending_count: pendingCount,
          oldest_pending_age_seconds: oldestPendingAge,
          threshold_seconds: maxLagSeconds,
        },
        outbox: {
          pending_count: pendingOutbox,
        },
      };
    } catch (err: any) {
      reply.code(503);
      return {
        status: 'not_ready',
        error: err.message || 'Database unavailable',
      };
    }
  });

  // Prometheus metrics endpoint
  fastify.get('/metrics', async (req, reply) => {
    try {
      // 1. Refresh queue depth gauges by status
      const statusRes = await pool.query<{ processing_status: string; count: string }>(
        'SELECT processing_status, count(*) as count FROM events GROUP BY processing_status'
      );
      for (const row of statusRes.rows) {
        queueDepthGauge.set({ status: row.processing_status }, Number(row.count));
      }

      // 2. Refresh incidents gauges by state
      const incRes = await pool.query<{ status: string; count: string }>(
        'SELECT status, count(*) as count FROM incidents GROUP BY status'
      );
      for (const row of incRes.rows) {
        incidentsGauge.set({ status: row.status }, Number(row.count));
        incidentsByStateGauge.set({ state: row.status }, Number(row.count));
      }

      // 3. Refresh outbox by status gauges
      const outboxRes = await pool.query<{ status: string; count: string }>(
        'SELECT status, count(*) as count FROM notification_outbox GROUP BY status'
      );
      for (const row of outboxRes.rows) {
        outboxByStatusGauge.set({ status: row.status }, Number(row.count));
      }

      // 4. Refresh cumulative processing attempts and failures
      const attemptsRes = await pool.query<{ total_attempts: string; failures: string }>(
        `SELECT COALESCE(SUM(attempts), 0) as total_attempts,
                count(*) FILTER (WHERE processing_status = 'failed') as failures
         FROM events`
      );
      if (attemptsRes.rows[0]) {
        eventProcessingAttemptsGauge.set(Number(attemptsRes.rows[0].total_attempts));
        eventProcessingFailuresGauge.set(Number(attemptsRes.rows[0].failures));
      }

      // 5. Refresh SSE client count
      sseActiveClientsGauge.set(getActiveSSEClientCount());

      // 6. Refresh Circuit Breaker states per host
      const cbRes = await pool.query<{ host: string; state: string }>(
        'SELECT host, state FROM circuit_breaker_states'
      );
      const stateToNum = (s: string) => (s === 'OPEN' ? 2 : s === 'HALF_OPEN' ? 1 : 0);
      for (const row of cbRes.rows) {
        circuitBreakerStateGauge.set({ host: row.host }, stateToNum(row.state));
      }
      // If none in table yet, provide default sink host as CLOSED
      if (cbRes.rows.length === 0) {
        circuitBreakerStateGauge.set({ host: 'notification-sink:4000' }, 0);
      }

      reply.header('Content-Type', register.contentType);
      return await register.metrics();
    } catch (err: any) {
      reply.code(500).send({ error: err.message });
    }
  });

  // Operator Dashboard Stats summary:
  // events/min, devices by status, open incidents by severity, queue depth and lag, failed events, outbox state
  fastify.get('/api/stats', async () => {
    // 1. Events/min
    const eventsPerMinRes = await pool.query<{ count: string }>(
      "SELECT count(*) as count FROM events WHERE received_at >= NOW() - INTERVAL '1 minute'"
    );
    const eventsPerMinute = Number(eventsPerMinRes.rows[0]?.count || 0);

    // 2. Devices by status
    const devicesRes = await pool.query(`
      SELECT count(*) as total,
             count(*) FILTER (WHERE status = 'online') as online,
             count(*) FILTER (WHERE status = 'stale') as stale,
             count(*) FILTER (WHERE status = 'offline') as offline,
             count(*) FILTER (WHERE status = 'unknown' OR status IS NULL) as unknown
      FROM devices
    `);

    // 3. Open incidents by severity
    const incidentsRes = await pool.query(`
      SELECT count(*) as total,
             count(*) FILTER (WHERE status IN ('open', 'acknowledged')) as total_open,
             count(*) FILTER (WHERE status = 'open') as open,
             count(*) FILTER (WHERE status = 'acknowledged') as acknowledged,
             count(*) FILTER (WHERE status IN ('resolved', 'auto_resolved')) as resolved,
             count(*) FILTER (WHERE status IN ('open', 'acknowledged') AND severity = 'critical') as critical,
             count(*) FILTER (WHERE status IN ('open', 'acknowledged') AND severity = 'warning') as warning,
             count(*) FILTER (WHERE status IN ('open', 'acknowledged') AND severity = 'info') as info
      FROM incidents
    `);

    // 4. Queue depth and lag
    const queueRes = await pool.query(`
      SELECT count(*) as total_events,
             count(*) FILTER (WHERE processing_status = 'pending') as depth,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(received_at) FILTER (WHERE processing_status = 'pending'))), 0) as lag_seconds,
             count(*) FILTER (WHERE processing_status = 'pending') as pending,
             count(*) FILTER (WHERE processing_status = 'processing') as processing,
             count(*) FILTER (WHERE processing_status = 'done') as done,
             count(*) FILTER (WHERE processing_status = 'failed') as failed
      FROM events
    `);

    // 5. Outbox state
    const outboxRes = await pool.query(`
      SELECT count(*) as total,
             count(*) FILTER (WHERE status = 'pending') as pending,
             count(*) FILTER (WHERE status = 'in_flight') as in_flight,
             count(*) FILTER (WHERE status IN ('sent', 'delivered')) as sent,
             count(*) FILTER (WHERE status = 'failed') as failed,
             count(*) FILTER (WHERE status = 'dead') as dead
      FROM notification_outbox
    `);

    const rejectedRes = await pool.query('SELECT count(*) as total FROM rejected_events');

    const queueData = queueRes.rows[0];
    const lagSeconds = Math.round(Number(queueData?.lag_seconds || 0));

    return {
      events_per_minute: eventsPerMinute,
      devices_by_status: {
        total: Number(devicesRes.rows[0]?.total || 0),
        online: Number(devicesRes.rows[0]?.online || 0),
        stale: Number(devicesRes.rows[0]?.stale || 0),
        offline: Number(devicesRes.rows[0]?.offline || 0),
        unknown: Number(devicesRes.rows[0]?.unknown || 0),
      },
      open_incidents_by_severity: {
        total_open: Number(incidentsRes.rows[0]?.total_open || 0),
        critical: Number(incidentsRes.rows[0]?.critical || 0),
        warning: Number(incidentsRes.rows[0]?.warning || 0),
        info: Number(incidentsRes.rows[0]?.info || 0),
      },
      queue_depth_and_lag: {
        depth: Number(queueData?.depth || 0),
        pending_depth: Number(queueData?.depth || 0),
        lag_seconds: lagSeconds,
        pending: Number(queueData?.pending || 0),
        processing: Number(queueData?.processing || 0),
        done: Number(queueData?.done || 0),
        failed: Number(queueData?.failed || 0),
      },
      failed_events: {
        failed_count: Number(queueData?.failed || 0),
        rejected_count: Number(rejectedRes.rows[0]?.total || 0),
      },
      outbox_state: {
        total: Number(outboxRes.rows[0]?.total || 0),
        pending: Number(outboxRes.rows[0]?.pending || 0),
        in_flight: Number(outboxRes.rows[0]?.in_flight || 0),
        sent: Number(outboxRes.rows[0]?.sent || 0),
        failed: Number(outboxRes.rows[0]?.failed || 0),
        dead: Number(outboxRes.rows[0]?.dead || 0),
      },
      // Backward compatibility fields
      devices: devicesRes.rows[0],
      incidents: incidentsRes.rows[0],
      queue: queueData,
      outbox: outboxRes.rows[0],
      rejected_events_count: Number(rejectedRes.rows[0]?.total || 0),
    };
  });

  // GET /api/dead-letters (failed events & dead notifications)
  fastify.get('/api/dead-letters', async () => {
    const failedEventsRes = await pool.query(
      `SELECT event_id, device_id, seq, ts, received_at, type, payload, attempts, last_error
       FROM events
       WHERE processing_status = 'failed'
       ORDER BY received_at DESC
       LIMIT 100`
    );

    const deadOutboxRes = await pool.query(
      `SELECT id, incident_id, operator_id, destination_url, payload, attempts, last_error, updated_at
       FROM notification_outbox
       WHERE status = 'dead'
       ORDER BY updated_at DESC
       LIMIT 100`
    );

    const rejectedRes = await pool.query(
      `SELECT id, device_id, reason, raw_payload, rejected_at
       FROM rejected_events
       ORDER BY rejected_at DESC
       LIMIT 50`
    );

    return {
      failed_events: failedEventsRes.rows,
      total_failed_events: failedEventsRes.rows.length,
      dead_notifications: deadOutboxRes.rows,
      total_dead_notifications: deadOutboxRes.rows.length,
      rejected_events: rejectedRes.rows,
    };
  });

  // POST /api/dead-letters/requeue (requeue failed events and/or dead notifications)
  fastify.post('/api/dead-letters/requeue', async (req) => {
    const body = (req.body as { type?: 'events' | 'notifications' | 'all'; id?: string }) || {};
    const targetType = body.type || 'all';

    let requeuedEvents = 0;
    let requeuedNotifications = 0;

    // 1. Requeue events
    if (targetType === 'events' || targetType === 'all') {
      if (body.id) {
        const res = await pool.query(
          `UPDATE events
           SET processing_status = 'pending', attempts = 0, locked_until = NULL, last_error = NULL
           WHERE event_id = $1 AND processing_status = 'failed'
           RETURNING event_id`,
          [body.id]
        );
        requeuedEvents = res.rows.length;
      } else {
        const res = await pool.query(
          `UPDATE events
           SET processing_status = 'pending', attempts = 0, locked_until = NULL, last_error = NULL
           WHERE processing_status = 'failed'
           RETURNING event_id`
        );
        requeuedEvents = res.rows.length;
      }
    }

    // 2. Requeue notifications
    if (targetType === 'notifications' || targetType === 'all') {
      if (body.id) {
        const res = await pool.query(
          `UPDATE notification_outbox
           SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'dead'
           RETURNING id`,
          [body.id]
        );
        requeuedNotifications = res.rows.length;
      } else {
        const res = await pool.query(
          `UPDATE notification_outbox
           SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL, updated_at = NOW()
           WHERE status = 'dead'
           RETURNING id`
        );
        requeuedNotifications = res.rows.length;
      }
    }

    return {
      success: true,
      requeued_events: requeuedEvents,
      requeued_notifications: requeuedNotifications,
    };
  });
};
