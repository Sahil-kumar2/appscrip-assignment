import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { createLogger } from '@aps/shared';

const logger = createLogger({ service: 'notification-routes' });

export interface NotificationRouteOptions {
  pool: pg.Pool;
}

export const notificationRoutes: FastifyPluginAsync<NotificationRouteOptions> = async (
  fastify,
  opts
) => {
  const { pool } = opts;

  // List notifications
  fastify.get('/api/notifications', async (req) => {
    const query = req.query as {
      status?: string;
      incident_id?: string;
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
    const offset = Math.max(0, Number(query.offset || 0));

    const params: any[] = [];
    let sql = `
      SELECT no.*, o.name as operator_name
      FROM notification_outbox no
      LEFT JOIN operators o ON o.id = no.operator_id
      WHERE 1=1
    `;

    if (query.status) {
      params.push(query.status);
      sql += ` AND no.status = $${params.length}`;
    }

    if (query.incident_id) {
      params.push(query.incident_id);
      sql += ` AND no.incident_id = $${params.length}`;
    }

    sql += ` ORDER BY no.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const res = await pool.query(sql, params);
    return { notifications: res.rows };
  });

  // Retry a specific notification by ID
  fastify.post('/api/notifications/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };

    const checkRes = await pool.query('SELECT id, status FROM notification_outbox WHERE id = $1', [
      id,
    ]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ error: `Notification '${id}' not found` });
    }

    const res = await pool.query(
      `UPDATE notification_outbox
       SET status = 'pending',
           attempts = 0,
           next_attempt_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    logger.info({ notificationId: id }, 'Notification requeued for delivery');
    return {
      success: true,
      message: `Notification '${id}' has been reset to pending status`,
      notification: res.rows[0],
    };
  });

  // Retry all dead notifications (with optional incident_id filter)
  fastify.post('/api/notifications/retry-dead', async (req) => {
    const body = (req.body as { incident_id?: string }) || {};
    const query = (req.query as { incident_id?: string }) || {};
    const incidentId = body.incident_id || query.incident_id;

    let sql = `
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
      sql += ' AND incident_id = $1';
    }
    sql += ' RETURNING id';

    const res = await pool.query(sql, params);
    const retriedCount = res.rows.length;

    logger.info({ retriedCount, incidentId }, 'Retried dead notifications');
    return {
      success: true,
      retried_count: retriedCount,
      retried_ids: res.rows.map((r) => r.id),
    };
  });
};
