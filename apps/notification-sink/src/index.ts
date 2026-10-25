import fastify from 'fastify';
import cors from '@fastify/cors';
import { createLogger } from '@aps/shared';

const logger = createLogger({ service: 'notification-sink' });

export type SinkMode = 'ok' | 'fail' | 'slow';

export interface StoredNotification {
  id: string;
  idempotencyKey?: string;
  receivedAt: string;
  headers: Record<string, unknown>;
  body: unknown;
}

export interface AdminModeConfig {
  mode: SinkMode;
  slow_delay_ms?: number;
}

export function buildNotificationSink() {
  const server = fastify({
    logger: false,
  });

  server.register(cors, { origin: true });

  const notifications: StoredNotification[] = [];
  const idempotencyMap = new Map<string, StoredNotification>();
  const maxStorage = 500;

  let currentMode: SinkMode = 'ok';
  let slowDelayMs = 4000;

  server.get('/healthz', async () => {
    return { status: 'ok', mode: currentMode, slow_delay_ms: slowDelayMs };
  });

  // Admin endpoint to simulate outages: mode="ok"|"fail"|"slow"
  server.post('/admin/mode', async (req, reply) => {
    const body = (req.body as Partial<AdminModeConfig>) || {};
    const validModes: SinkMode[] = ['ok', 'fail', 'slow'];

    if (!body.mode || !validModes.includes(body.mode)) {
      return reply.code(400).send({
        error: 'Invalid mode. Mode must be one of: "ok", "fail", "slow"',
      });
    }

    currentMode = body.mode;
    if (typeof body.slow_delay_ms === 'number' && body.slow_delay_ms > 0) {
      slowDelayMs = body.slow_delay_ms;
    }

    logger.info({ mode: currentMode, slowDelayMs }, 'Admin mode updated');
    return {
      status: 'ok',
      mode: currentMode,
      slow_delay_ms: slowDelayMs,
    };
  });

  server.get('/admin/mode', async () => {
    return { mode: currentMode, slow_delay_ms: slowDelayMs };
  });

  // Webhook handler that logs and stores received notifications
  const handleWebhook = async (req: any, reply: any) => {
    // 1. Simulate outage modes
    if (currentMode === 'fail') {
      logger.warn(
        { mode: currentMode },
        'Simulation outage: Webhook receiver returning failure (503)'
      );
      return reply.code(503).send({
        error: 'Simulation outage: Sink failure mode active',
        mode: 'fail',
      });
    }

    if (currentMode === 'slow') {
      logger.warn(
        { mode: currentMode, slowDelayMs },
        'Simulation outage: Webhook receiver delaying response'
      );
      await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
    }

    // 2. Extract Idempotency-Key
    const rawIdempotencyKey =
      req.headers['idempotency-key'] ||
      req.headers['x-idempotency-key'] ||
      req.headers['Idempotency-Key'];
    const idempotencyKey =
      typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : undefined;

    // 3. Deduplication via Idempotency-Key
    if (idempotencyKey && idempotencyMap.has(idempotencyKey)) {
      const existing = idempotencyMap.get(idempotencyKey)!;
      logger.info(
        { idempotencyKey, existingId: existing.id },
        'Idempotent duplicate notification received; acknowledged without duplicating'
      );
      return reply.code(200).send({
        status: 'ok',
        duplicate: true,
        received_id: existing.id,
        idempotency_key: idempotencyKey,
      });
    }

    // 4. Create and record new notification
    const item: StoredNotification = {
      id: `sink-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      headers: req.headers,
      body: req.body,
    };

    notifications.unshift(item);
    if (idempotencyKey) {
      idempotencyMap.set(idempotencyKey, item);
    }

    if (notifications.length > maxStorage) {
      const removed = notifications.pop();
      if (removed?.idempotencyKey) {
        idempotencyMap.delete(removed.idempotencyKey);
      }
    }

    logger.info(
      { notificationId: item.id, idempotencyKey, body: item.body },
      'Notification received and stored successfully'
    );

    return reply.code(200).send({
      status: 'ok',
      duplicate: false,
      received_id: item.id,
      idempotency_key: idempotencyKey,
    });
  };

  server.post('/webhook', handleWebhook);
  server.post('/notifications', handleWebhook);
  server.post('/', handleWebhook);

  // Expose GET /received
  server.get('/received', async (req) => {
    const q = req.query as { idempotency_key?: string };
    if (q.idempotency_key) {
      const item = idempotencyMap.get(q.idempotency_key);
      return {
        total: item ? 1 : 0,
        notifications: item ? [item] : [],
      };
    }

    return {
      total: notifications.length,
      notifications,
    };
  });

  // Alias for backward compatibility
  server.get('/notifications', async (req) => {
    return server
      .inject({
        method: 'GET',
        url: `/received?${new URLSearchParams(req.query as any).toString()}`,
      })
      .then((r) => r.json());
  });

  server.delete('/received', async () => {
    notifications.length = 0;
    idempotencyMap.clear();
    return { status: 'cleared' };
  });

  server.delete('/notifications', async () => {
    notifications.length = 0;
    idempotencyMap.clear();
    return { status: 'cleared' };
  });

  // Legacy chaos endpoint for backward compatibility
  server.post('/chaos', async (req, reply) => {
    const body = (req.body as any) || {};
    if (body.enabled === true) {
      currentMode = 'fail';
    } else if (body.enabled === false) {
      currentMode = 'ok';
    }
    return { status: 'ok', mode: currentMode };
  });

  return server;
}

async function start() {
  const port = Number(process.env.PORT || 4000);
  const host = process.env.HOST || '0.0.0.0';
  const server = buildNotificationSink();

  try {
    await server.listen({ port, host });
    logger.info({ port, host }, `Notification sink listening on http://${host}:${port}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start notification sink');
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMain) {
  start();
}
