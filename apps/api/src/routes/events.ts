import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import {
  hashDeviceKey,
  safeCompareHash,
  isDeviceTimestampValid,
  IngestEventSchema,
  IngestEventResult,
} from '@aps/shared';
import { DeviceRateLimiter } from '../rate-limiter.js';
import {
  eventsIngestedCounter,
  backpressureCounter,
  rateLimitCounter,
  requests429Counter,
} from '../metrics.js';

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

    const devRes = await pool.query<{
      id: string;
      location_id: string;
      status: string;
      last_seq: number;
      last_event_ts: Date | null;
      key_hash: string;
    }>(
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
    const rawBatch = req.body;
    if (!Array.isArray(rawBatch)) {
      return reply.code(400).send({
        error: 'Invalid batch payload: request body must be a JSON array of events',
      });
    }

    if (rawBatch.length === 0) {
      return reply.code(400).send({
        error: 'Invalid batch payload: batch must contain at least 1 event',
      });
    }

    if (rawBatch.length > 500) {
      return reply.code(400).send({
        error: `Invalid batch payload: batch size (${rawBatch.length}) exceeds maximum limit of 500`,
      });
    }

    const results: IngestEventResult[] = [];
    const now = new Date();
    const batchSeenIds = new Set<string>();

    let maxSeqReceived = Number(device.last_seq);
    let maxEventTs: Date | null = device.last_event_ts ? new Date(device.last_event_ts) : null;
    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;

    // 5. Insert accepted events in ONE transaction with ON CONFLICT DO NOTHING RETURNING
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const rawItem of rawBatch) {
        // Individual event schema validation with Zod
        const parsed = IngestEventSchema.safeParse(rawItem);
        if (!parsed.success) {
          const reason = `Validation error: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`;
          const eventId =
            rawItem && typeof (rawItem as any).event_id === 'string'
              ? (rawItem as any).event_id
              : '00000000-0000-0000-0000-000000000000';

          // Insert into rejected_events (capped table)
          await client.query(
            `INSERT INTO rejected_events (device_id, raw_payload, reason)
             VALUES ($1, $2::jsonb, $3)`,
            [device.id, JSON.stringify(rawItem ?? null), reason]
          );

          eventsIngestedCounter.inc({ status: 'rejected' });
          results.push({ event_id: eventId, status: 'rejected', reason });
          rejectedCount++;
          continue;
        }

        const ev = parsed.data;

        // Reject mismatched device_id in events
        if (ev.device_id !== device.id) {
          const reason = `Device ID in event payload (${ev.device_id}) does not match authenticated device (${device.id})`;
          await client.query(
            `INSERT INTO rejected_events (device_id, raw_payload, reason)
             VALUES ($1, $2::jsonb, $3)`,
            [device.id, JSON.stringify(rawItem), reason]
          );

          eventsIngestedCounter.inc({ status: 'rejected' });
          results.push({ event_id: ev.event_id, status: 'rejected', reason });
          rejectedCount++;
          continue;
        }

        // Timestamp skew check: reject ts more than 5 minutes in future
        const timeValid = isDeviceTimestampValid(ev.ts, 5, now);
        if (!timeValid.valid) {
          const reason = timeValid.reason || 'Timestamp too far in future';
          await client.query(
            `INSERT INTO rejected_events (device_id, raw_payload, reason)
             VALUES ($1, $2::jsonb, $3)`,
            [device.id, JSON.stringify(rawItem), reason]
          );

          eventsIngestedCounter.inc({ status: 'rejected' });
          results.push({ event_id: ev.event_id, status: 'rejected', reason });
          rejectedCount++;
          continue;
        }

        // Intra-batch duplicate check
        if (batchSeenIds.has(ev.event_id)) {
          eventsIngestedCounter.inc({ status: 'duplicate' });
          results.push({
            event_id: ev.event_id,
            status: 'duplicate',
            reason: 'Duplicate event_id within batch',
          });
          duplicateCount++;
          continue;
        }
        batchSeenIds.add(ev.event_id);

        // Lateness check: received_at (now) - ts > lateWindow
        const eventDate = new Date(ev.ts);
        const isLate = now.getTime() - eventDate.getTime() > lateEventWindowSeconds * 1000;

        // Idempotent insertion: UNIQUE(device_id, event_id)
        const insertRes = await client.query<{ event_id: string }>(
          `INSERT INTO events (
             event_id, device_id, seq, ts, received_at, type, payload,
             schema_version, processing_status, attempts, is_late
           )
           VALUES ($1, $2, $3, $4, NOW(), $5, $6::jsonb, $7, 'pending', 0, $8)
           ON CONFLICT (device_id, event_id) DO NOTHING
           RETURNING event_id`,
          [
            ev.event_id,
            ev.device_id,
            ev.seq,
            ev.ts,
            ev.type,
            JSON.stringify(ev.payload),
            ev.schema_version,
            isLate,
          ]
        );

        if (insertRes.rows.length > 0) {
          // Newly accepted event
          eventsIngestedCounter.inc({ status: 'accepted' });
          results.push({ event_id: ev.event_id, status: 'accepted' });
          acceptedCount++;

          if (ev.seq > maxSeqReceived) {
            maxSeqReceived = ev.seq;
          }
          if (!maxEventTs || eventDate > maxEventTs) {
            maxEventTs = eventDate;
          }

          // Write change_log record per accepted event
          await client.query(
            `INSERT INTO change_log (entity, entity_id, op, data)
             VALUES ('event', $1, 'INSERT', $2::jsonb)`,
            [
              ev.event_id,
              JSON.stringify({
                event_id: ev.event_id,
                device_id: ev.device_id,
                seq: ev.seq,
                type: ev.type,
                ts: ev.ts,
                is_late: isLate,
              }),
            ]
          );
        } else {
          // Duplicate event across batches
          eventsIngestedCounter.inc({ status: 'duplicate' });
          results.push({
            event_id: ev.event_id,
            status: 'duplicate',
            reason: 'Event already accepted for device',
          });
          duplicateCount++;
        }
      }

      // Update device last_seen_at = now() and last_event_ts = GREATEST(existing, ts)
      await client.query(
        `UPDATE devices
         SET last_seen_at = NOW(),
             last_event_ts = CASE 
               WHEN $1::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_event_ts, '1970-01-01'::timestamptz), $1::timestamptz)
               ELSE last_event_ts
             END,
             last_seq = GREATEST(last_seq, $2),
             status = 'online'
         WHERE id = $3`,
        [maxEventTs ? maxEventTs.toISOString() : null, maxSeqReceived, device.id]
      );

      // Write change_log row for device status change if transitioning to online
      if (device.status !== 'online') {
        await client.query(
          `INSERT INTO change_log (entity, entity_id, op, data)
           VALUES ('device', $1, 'UPDATE', $2::jsonb)`,
          [
            device.id,
            JSON.stringify({
              device_id: device.id,
              from_status: device.status,
              to_status: 'online',
            }),
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // NOTIFY after commit if any events were accepted
    if (acceptedCount > 0) {
      pool.query("SELECT pg_notify('change_log', 'events_ingested')").catch(() => {});
    }

    // Log structured line per request
    const durationMs = Number(process.hrtime.bigint() - startHrTime) / 1_000_000;
    const reqLogger = (req as any).log || req.log;
    reqLogger.info(
      {
        requestId: req.id,
        device_id: device.id,
        batch_size: rawBatch.length,
        accepted: acceptedCount,
        duplicate: duplicateCount,
        rejected: rejectedCount,
        duration_ms: Math.round(durationMs * 100) / 100,
      },
      'Ingestion batch processed'
    );

    // Always 200 with per-event results
    return reply.code(200).send({ results });
  });

  // Query events endpoint with cursor pagination
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
    const params: any[] = [];
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
    const params: any[] = [];
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
