import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashDeviceKey, createLogger } from '@aps/shared';

const logger = createLogger({ service: 'device-routes' });

export interface DeviceRouteOptions {
  pool: pg.Pool;
}

const CreateDeviceSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1, 'Device name is required'),
  location_id: z.string().optional().nullable(),
  raw_key: z.string().min(8).optional(),
});

export const deviceRoutes: FastifyPluginAsync<DeviceRouteOptions> = async (fastify, opts) => {
  const { pool } = opts;

  // List devices with optional location_id and status filters
  fastify.get('/api/devices', async (req) => {
    const query = req.query as {
      location_id?: string;
      status?: string;
    };

    const params: any[] = [];
    let sql = `
      SELECT d.id, d.name, d.location_id, d.status, d.last_seen_at, d.last_event_ts, d.last_seq, d.created_at,
             l.name as location_name
      FROM devices d
      LEFT JOIN locations l ON l.id = d.location_id
      WHERE 1=1
    `;

    if (query.location_id) {
      params.push(query.location_id);
      sql += ` AND d.location_id = $${params.length}`;
    }

    if (query.status) {
      params.push(query.status);
      sql += ` AND d.status = $${params.length}`;
    }

    sql += ' ORDER BY d.created_at DESC';

    const res = await pool.query(sql, params);
    return { devices: res.rows };
  });

  // Get single device
  fastify.get('/api/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await pool.query(
      `SELECT d.id, d.name, d.location_id, d.status, d.last_seen_at, d.last_event_ts, d.last_seq, d.created_at,
              l.name as location_name
       FROM devices d
       LEFT JOIN locations l ON l.id = d.location_id
       WHERE d.id = $1`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: `Device '${id}' not found` });
    }

    return { device: res.rows[0] };
  });

  // Create new device and return raw API key (printed/shown once)
  fastify.post('/api/devices', async (req, reply) => {
    const parsed = CreateDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `Validation error: ${parsed.error.errors.map((e) => e.message).join('; ')}`,
      });
    }

    const { name, location_id } = parsed.data;
    const deviceId = parsed.data.id || `dev-${randomUUID().substring(0, 8)}`;
    const rawKey = parsed.data.raw_key || `dev_key_${randomBytes(24).toString('hex')}`;
    const keyHash = hashDeviceKey(rawKey);

    const res = await pool.query(
      `INSERT INTO devices (id, name, location_id, key_hash, status, created_at)
       VALUES ($1, $2, $3, $4, 'online', NOW())
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, location_id = EXCLUDED.location_id
       RETURNING id, name, location_id, status, created_at`,
      [deviceId, name, location_id || null, keyHash]
    );

    // Record change log
    await pool.query(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('device', $1, 'INSERT', $2::jsonb)`,
      [
        deviceId,
        JSON.stringify({
          id: deviceId,
          name,
          location_id,
        }),
      ]
    );

    logger.info({ deviceId, name }, 'Device registered');
    return reply.code(201).send({
      device: res.rows[0],
      raw_key: rawKey,
      message: 'Device created successfully. Store raw_key securely; it cannot be viewed again.',
    });
  });

  // Rotate device key
  fastify.post('/api/devices/:id/rotate-key', async (req, reply) => {
    const { id } = req.params as { id: string };

    const checkRes = await pool.query('SELECT id, name FROM devices WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ error: `Device '${id}' not found` });
    }

    const newKey = `dev_key_${randomBytes(24).toString('hex')}`;
    const newKeyHash = hashDeviceKey(newKey);

    await pool.query('UPDATE devices SET key_hash = $1 WHERE id = $2', [newKeyHash, id]);

    await pool.query(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('device', $1, 'UPDATE', $2::jsonb)`,
      [
        id,
        JSON.stringify({
          id,
          action: 'key_rotated',
          rotated_at: new Date().toISOString(),
        }),
      ]
    );

    logger.info({ deviceId: id }, 'Rotated device bearer key');
    return {
      id,
      device_id: id,
      raw_key: newKey,
      message: 'Device key rotated successfully. Update your device with this new Bearer key.',
    };
  });

  fastify.get('/api/locations', async () => {
    const res = await pool.query('SELECT * FROM locations ORDER BY name ASC');
    return { locations: res.rows };
  });

  fastify.get('/api/operators', async () => {
    const res = await pool.query(`
      SELECT o.*, l.name as location_name
      FROM operators o
      LEFT JOIN locations l ON l.id = o.location_id
      ORDER BY o.name ASC
    `);
    return { operators: res.rows };
  });
};
