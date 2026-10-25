import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { hashDeviceKey, safeCompareHash } from '@aps/shared';
import { DeviceRateLimiter } from '../rate-limiter.js';
import { backpressureCounter, rateLimitCounter, requests429Counter } from '../metrics.js';
import { IngestionService, AuthenticatedDeviceRecord } from '../services/ingestion.service.js';

export interface EventsRouteOptions {
  pool: pg.Pool;
  rateLimiter: DeviceRateLimiter;
  queueBackpressureThreshold: number;
  lateEventWindowSeconds?: number;
}

/**
 * In-memory cache for queue pending count (~1s TTL) to prevent expensive
 * count(*) queries on every single HTTP ingest request under high load.
 */
export class PendingDepthCache {
  private lastCheck = 0;
  private cachedCount = 0;
  private readonly ttlMs: number;

  constructor(ttlMs: number = 1000) {
    this.ttlMs = ttlMs;
  }

  async getPendingCount(pool: pg.Pool): Promise<number> {
    const now = Date.now();
    if (now - this.lastCheck < this.ttlMs) {
      return this.cachedCount;
    }
    const res = await pool.query<{ count: string }>(
      "SELECT count(*) as count FROM events WHERE processing_status = 'pending'"
    );
    this.cachedCount = Number(res.rows[0]?.count || 0);
    this.lastCheck = now;
    return this.cachedCount;
  }

  invalidate(): void {
    this.lastCheck = 0;
  }

  set(count: number): void {
    this.cachedCount = count;
    this.lastCheck = Date.now();
  }
}

export const eventsRoutes: FastifyPluginAsync<EventsRouteOptions> = async (fastify, opts) => {
  const { pool, rateLimiter, queueBackpressureThreshold, lateEventWindowSeconds = 300 } = opts;
  const depthCache = new PendingDepthCache(1000);
  const ingestionService = new IngestionService(lateEventWindowSeconds);
  const DUMMY_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  fastify.post('/v1/events', async (req, reply) => {
    const startHrTime = process.hrtime.bigint();

    // 1. Bearer Token Authentication (constant-time compare of hash)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const rawKey = authHeader.substring(7).trim();
    if (!rawKey) {
      return reply.code(401).send({ error: 'Device key is empty' });
    }

    const incomingHash = hashDeviceKey(rawKey);

    const devRes = await pool.query<AuthenticatedDeviceRecord>(
      'SELECT id, location_id, status, last_seq, last_event_ts, key_hash FROM devices WHERE key_hash = $1',
      [incomingHash]
    );

    if (devRes.rows.length === 0) {
      // Execute constant-time comparison against dummy to prevent timing side-channels
      safeCompareHash(incomingHash, DUMMY_HASH);
      return reply.code(401).send({ error: 'Unauthorized: Device key not recognized' });
    }

    const device = devRes.rows[0];

    // Verify hash using constant-time comparison
    if (!safeCompareHash(incomingHash, device.key_hash)) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid device key hash' });
    }

    // 2. In-Memory Per-Device Token Bucket Rate Limiting
    const rateCheck = rateLimiter.check(device.id);
    reply.header('X-RateLimit-Remaining', rateCheck.remaining);
    if (!rateCheck.allowed) {
      rateLimitCounter.inc({ device_id: device.id });
      requests429Counter.inc({ reason: 'rate_limit' });
      const retryAfterSec = Math.ceil(rateCheck.resetMs / 1000);
      reply.header('Retry-After', retryAfterSec);
      return reply.code(429).send({
        error: `Rate limit exceeded for device ${device.id}. Retry after ${retryAfterSec} seconds.`,
      });
    }

    // 3. Queue Backpressure Protection (cached for ~1s)
    const pendingDepth = await depthCache.getPendingCount(pool);
    if (pendingDepth >= queueBackpressureThreshold) {
      backpressureCounter.inc();
      requests429Counter.inc({ reason: 'queue_backpressure' });
      reply.header('Retry-After', '5');
      return reply.code(429).send({
        error: `Ingestion queue backpressure: pending depth (${pendingDepth}) exceeds threshold (${queueBackpressureThreshold}). Retry after 5 seconds.`,
      });
    }

    // 4. Batch Validation: must be array, 1 to 500 items
    const batchValidation = ingestionService.validateRawBatch(req.body);
    if (batchValidation.error) {
      return reply.code(400).send({ error: batchValidation.error });
    }
    const rawBatch = batchValidation.batch!;

    // 5. Ingest Batch via IngestionService inside transaction
    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      outcome = await ingestionService.ingestBatch(client, device, rawBatch);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 6. Notify after commit if any events were accepted
    if (outcome.acceptedCount > 0) {
      pool.query("SELECT pg_notify('change_log', 'events_ingested')").catch(() => {});
    }

    // 7. Structured request logging
    const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;
    const reqLogger = (req as any).log || req.log;
    reqLogger.info(
      {
        requestId: req.id,
        device_id: device.id,
        batch_size: rawBatch.length,
        accepted: outcome.acceptedCount,
        duplicate: outcome.duplicateCount,
        rejected: outcome.rejectedCount,
        duration_ms: Math.round(durationMs * 100) / 100,
      },
      'Ingestion batch processed'
    );

    // Always 200 with per-event results
    return reply.code(200).send({ results: outcome.results });
  });

  // Query events endpoint with cursor & offset pagination
  fastify.get('/api/events', async (req) => {
    const query = req.query as {
      cursor?: string;
      limit?: string;
      device_id?: string;
      status?: string;
      type?: string;
      offset?: string;
    };

    const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
    const params: unknown[] = [];
    let sql = 'SELECT * FROM events WHERE 1=1';

    if (query.device_id) {
      params.push(query.device_id);
      sql += ` AND device_id = $${params.length}`;
    }

    if (query.status) {
      params.push(query.status);
      sql += ` AND processing_status = $${params.length}`;
    }

    if (query.type) {
      params.push(query.type);
      sql += ` AND type = $${params.length}`;
    }

    // Cursor pagination (decodes base64 { received_at, event_id })
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64').toString('utf-8'));
        if (decoded.received_at && decoded.event_id) {
          params.push(decoded.received_at);
          params.push(decoded.event_id);
          sql += ` AND (received_at, event_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
        }
      } catch {
        // Fallback if cursor format is malformed
      }
    } else if (query.offset) {
      // Backward-compatible offset pagination support
      const offset = Math.max(0, Number(query.offset || 0));
      params.push(limit);
      params.push(offset);
      sql += ` ORDER BY received_at DESC, event_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const res = await pool.query(sql, params);
      return {
        events: res.rows,
        limit,
        offset,
      };
    }

    params.push(limit + 1);
    sql += ` ORDER BY received_at DESC, event_id DESC LIMIT $${params.length}`;

    const res = await pool.query(sql, params);
    const hasMore = res.rows.length > limit;
    const events = hasMore ? res.rows.slice(0, limit) : res.rows;

    let nextCursor: string | null = null;
    if (hasMore && events.length > 0) {
      const last = events[events.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({
          received_at: last.received_at,
          event_id: last.event_id,
        })
      ).toString('base64');
    }

    return {
      events,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  });

  // Requeue single failed event
  fastify.post('/api/events/:id/requeue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await pool.query<{ event_id: string }>(
      `UPDATE events
       SET processing_status = 'pending',
           attempts = 0,
           locked_until = NULL,
           last_error = NULL
       WHERE event_id = $1 AND processing_status = 'failed'
       RETURNING event_id`,
      [id]
    );

    if (res.rows.length === 0) {
      return reply.code(404).send({
        error: `Event ${id} not found with processing_status = 'failed'`,
      });
    }

    return {
      success: true,
      requeued_event_id: res.rows[0].event_id,
      message: `Event ${id} requeued to 'pending'`,
    };
  });

  // Requeue batch of failed events
  fastify.post('/api/events/requeue-failed', async (req) => {
    const query = req.query as { device_id?: string };
    let sql = `
      UPDATE events
      SET processing_status = 'pending',
          attempts = 0,
          locked_until = NULL,
          last_error = NULL
      WHERE processing_status = 'failed'
    `;
    const params: unknown[] = [];
    if (query.device_id) {
      params.push(query.device_id);
      sql += ` AND device_id = $1`;
    }
    sql += ' RETURNING event_id';

    const res = await pool.query<{ event_id: string }>(sql, params);
    return {
      success: true,
      requeued_count: res.rows.length,
      requeued_event_ids: res.rows.map((r) => r.event_id),
    };
  });

  // Rejected events audit endpoint
  fastify.get('/api/rejected-events', async (req) => {
    const limit = 50;
    const res = await pool.query(
      'SELECT * FROM rejected_events ORDER BY rejected_at DESC LIMIT $1',
      [limit]
    );
    return { rejected_events: res.rows };
  });
};
