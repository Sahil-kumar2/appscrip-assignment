import { FastifyPluginAsync, FastifyReply } from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@aps/shared';

const logger = createLogger({ service: 'sse-stream' });

export interface StreamRouteOptions {
  pool: pg.Pool;
}

export interface StreamSubscriber {
  id: string;
  raw: FastifyReply['raw'];
  lastSeq: number;
  isClosed: boolean;
}

/**
 * Manages a single dedicated PostgreSQL LISTEN connection for the change_log channel,
 * fanning out real-time updates to all connected SSE clients with message throttling,
 * periodic heartbeats, and replay gap tracking.
 */
export class ChangeLogBroadcaster {
  private pool: pg.Pool;
  private subscribers: Map<string, StreamSubscriber> = new Map();
  private listenerClient: pg.PoolClient | null = null;
  private highestSeq = 0;
  private isListening = false;
  private isStopping = false;
  private isFlushing = false;
  private pendingFlush = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastFlushTime = 0;

  readonly MIN_FLUSH_INTERVAL_MS = 100; // Throttle to at most ~10 flushes/sec
  readonly REPLAY_CAP = 500;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async ensureStarted(): Promise<void> {
    if (this.isListening || this.isStopping) return;
    this.isListening = true;

    try {
      const maxRes = await this.pool.query<{ max_seq: string }>(
        'SELECT COALESCE(MAX(seq), 0) as max_seq FROM change_log'
      );
      this.highestSeq = Number(maxRes.rows[0]?.max_seq || 0);
    } catch (err) {
      logger.warn({ err }, 'Error determining initial max seq for change_log broadcaster');
    }

    try {
      const client = await this.pool.connect();
      this.listenerClient = client;

      client.on('notification', (msg: pg.Notification) => {
        if (msg.channel === 'change_log') {
          this.scheduleFlush();
        }
      });

      client.on('error', (err: any) => {
        if (!this.isStopping && !(this.pool as any).ended) {
          logger.warn({ err }, 'Stream listener client encountered an error; scheduling reconnect');
          this.reconnect();
        }
      });

      await client.query('LISTEN change_log');
      logger.info(
        { highestSeq: this.highestSeq },
        'Established single LISTEN connection for change_log stream'
      );
    } catch (err) {
      logger.warn({ err }, 'Unable to connect dedicated LISTEN connection (mock pool or offline)');
    }

    if (!this.heartbeatTimer) {
      // Periodic heartbeat comments every 15s
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat();
      }, 15000).unref();
    }
  }

  private reconnect(): void {
    if (this.isStopping || (this.pool as any).ended || (this.pool as any).ending) return;
    if (this.listenerClient) {
      try {
        this.listenerClient.release();
      } catch {
        // Ignore release errors on dead client
      }
      this.listenerClient = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isStopping || (this.pool as any).ended || (this.pool as any).ending) return;
      try {
        const client = await this.pool.connect();
        this.listenerClient = client;
        client.on('notification', (msg: pg.Notification) => {
          if (msg.channel === 'change_log') {
            this.scheduleFlush();
          }
        });
        client.on('error', () => {
          if (!this.isStopping && !(this.pool as any).ended) {
            this.reconnect();
          }
        });
        await client.query('LISTEN change_log');
        logger.info('Broadcaster LISTEN connection successfully reconnected');
        this.scheduleFlush();
      } catch (err) {
        if (!this.isStopping && !(this.pool as any).ended) {
          logger.warn({ err }, 'Broadcaster reconnect failed; retrying in 2000ms');
          this.reconnect();
        }
      }
    }, 2000).unref();
  }

  async addSubscriber(subscriber: StreamSubscriber): Promise<void> {
    this.subscribers.set(subscriber.id, subscriber);
    logger.info(
      { subscriberId: subscriber.id, totalSubscribers: this.subscribers.size },
      'SSE subscriber registered'
    );

    // Gap protection: catch up any change_log rows beyond subscriber.lastSeq
    if (!subscriber.isClosed) {
      try {
        const catchupRes = await this.pool.query(
          `SELECT seq, entity, entity_id, op, data, entity_type, action, payload, created_at
           FROM change_log
           WHERE seq > $1
           ORDER BY seq ASC
           LIMIT 500`,
          [subscriber.lastSeq]
        );

        for (const row of catchupRes.rows) {
          if (subscriber.isClosed) break;
          const seq = Number(row.seq);
          if (seq > subscriber.lastSeq) {
            subscriber.lastSeq = seq;
            const msg = `id: ${row.seq}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`;
            subscriber.raw.write(msg);
          }
          if (seq > this.highestSeq) {
            this.highestSeq = seq;
          }
        }
      } catch (err) {
        logger.warn({ err, subscriberId: subscriber.id }, 'Error catching up subscriber gap');
      }
    }
  }

  removeSubscriber(subscriberId: string): void {
    const sub = this.subscribers.get(subscriberId);
    if (sub) {
      sub.isClosed = true;
      this.subscribers.delete(subscriberId);
      logger.info(
        { subscriberId, remainingSubscribers: this.subscribers.size },
        'SSE subscriber removed'
      );
    }
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  scheduleFlush(): void {
    if (this.isStopping || (this.pool as any).ended || (this.pool as any).ending) return;
    if (this.isFlushing) {
      this.pendingFlush = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastFlushTime;

    if (elapsed >= this.MIN_FLUSH_INTERVAL_MS) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.MIN_FLUSH_INTERVAL_MS - elapsed);
    }
  }

  async flush(): Promise<void> {
    if (this.isStopping || (this.pool as any).ended || (this.pool as any).ending) return;
    if (this.isFlushing) {
      this.pendingFlush = true;
      return;
    }

    this.isFlushing = true;
    this.lastFlushTime = Date.now();

    try {
      const res = await this.pool.query(
        `SELECT seq, entity, entity_id, op, data, entity_type, action, payload, created_at
         FROM change_log
         WHERE seq > $1
         ORDER BY seq ASC
         LIMIT 500`,
        [this.highestSeq]
      );

      if (res.rows.length > 0) {
        for (const row of res.rows) {
          const seq = Number(row.seq);
          if (seq > this.highestSeq) {
            this.highestSeq = seq;
          }

          const sseMsg = `id: ${row.seq}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`;

          for (const [subId, sub] of this.subscribers) {
            if (!sub.isClosed && seq > sub.lastSeq) {
              sub.lastSeq = seq;
              try {
                sub.raw.write(sseMsg);
              } catch {
                this.removeSubscriber(subId);
              }
            }
          }
        }

        if (res.rows.length === 500) {
          this.scheduleFlush();
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error during broadcast flush');
    } finally {
      this.isFlushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        this.scheduleFlush();
      }
    }
  }

  getActiveSubscriberCount(): number {
    return this.subscribers.size;
  }

  sendHeartbeat(): void {
    for (const [subId, sub] of this.subscribers) {
      if (!sub.isClosed) {
        try {
          sub.raw.write(': heartbeat\n\n');
        } catch {
          this.removeSubscriber(subId);
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.listenerClient) {
      try {
        await this.listenerClient.query('UNLISTEN change_log');
      } catch {
        // Ignore unlisten errors
      }
      try {
        this.listenerClient.release();
      } catch {
        // Ignore release errors
      }
      this.listenerClient = null;
    }

    for (const sub of this.subscribers.values()) {
      sub.isClosed = true;
      try {
        sub.raw.end();
      } catch {
        // Ignore write errors
      }
    }
    this.subscribers.clear();
  }
}

let activeBroadcaster: ChangeLogBroadcaster | null = null;

export function getActiveSSEClientCount(): number {
  return activeBroadcaster ? activeBroadcaster.getActiveSubscriberCount() : 0;
}

export const streamRoutes: FastifyPluginAsync<StreamRouteOptions> = async (fastify, opts) => {
  const { pool } = opts;
  const broadcaster = new ChangeLogBroadcaster(pool);
  activeBroadcaster = broadcaster;

  fastify.addHook('onClose', async () => {
    await broadcaster.stop();
  });

  fastify.get('/api/stream', async (req, reply) => {
    // Set headers for Server-Sent Events
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.flushHeaders();

    const query = req.query as {
      last_event_id?: string;
      after_seq?: string;
      close_after_replay?: string;
      token?: string;
    };

    const headerId = req.headers['last-event-id'];
    const rawId =
      (typeof headerId === 'string' && headerId.trim()) ||
      (query.after_seq && query.after_seq.trim()) ||
      (query.last_event_id && query.last_event_id.trim()) ||
      null;

    let clientStartSeq = 0;

    if (rawId !== null) {
      const requestedSeq = Math.max(0, parseInt(rawId, 10) || 0);

      const gapRes = await pool.query<{ max_seq: string; gap_count: string }>(
        `SELECT COALESCE(MAX(seq), 0) as max_seq,
                COUNT(*) as gap_count
         FROM change_log
         WHERE seq > $1`,
        [requestedSeq]
      );

      const maxSeq = Number(gapRes.rows[0]?.max_seq || 0);
      const gapCount = Number(gapRes.rows[0]?.gap_count || 0);

      if (gapCount > broadcaster.REPLAY_CAP) {
        logger.warn(
          { requestedSeq, maxSeq, gapCount, cap: broadcaster.REPLAY_CAP },
          'SSE replay gap exceeded limit; signaling resync_required'
        );
        const resyncMsg = `id: ${maxSeq}\nevent: resync_required\ndata: ${JSON.stringify({
          error: 'resync_required',
          message: `Replay gap of ${gapCount} events exceeds maximum window of ${broadcaster.REPLAY_CAP}. Full resync required.`,
          latest_seq: maxSeq,
          gap_count: gapCount,
        })}\n\n`;
        reply.raw.write(resyncMsg);
        reply.raw.end();
        return;
      }

      if (gapCount > 0) {
        const replayRes = await pool.query(
          `SELECT seq, entity, entity_id, op, data, entity_type, action, payload, created_at
           FROM change_log
           WHERE seq > $1
           ORDER BY seq ASC
           LIMIT 500`,
          [requestedSeq]
        );

        for (const row of replayRes.rows) {
          const msg = `id: ${row.seq}\nevent: change\ndata: ${JSON.stringify(row)}\n\n`;
          reply.raw.write(msg);
        }
        clientStartSeq = maxSeq;
      } else {
        clientStartSeq = Math.max(requestedSeq, maxSeq);
      }
    } else {
      const maxRes = await pool.query<{ max_seq: string }>(
        'SELECT COALESCE(MAX(seq), 0) as max_seq FROM change_log'
      );
      clientStartSeq = Number(maxRes.rows[0]?.max_seq || 0);
    }

    if (query.close_after_replay === 'true') {
      reply.raw.end();
      return;
    }

    await broadcaster.ensureStarted();

    const subId = randomUUID();
    const subscriber: StreamSubscriber = {
      id: subId,
      raw: reply.raw,
      lastSeq: clientStartSeq,
      isClosed: false,
    };

    await broadcaster.addSubscriber(subscriber);

    const cleanup = () => {
      broadcaster.removeSubscriber(subId);
    };

    req.raw.on('close', cleanup);
    req.raw.on('end', cleanup);
    req.raw.on('error', cleanup);
  });
};
