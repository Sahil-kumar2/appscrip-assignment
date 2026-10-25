import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createLogger } from '@aps/shared';
import { ApiConfig } from './config.js';
import { DeviceRateLimiter } from './rate-limiter.js';
import { createOperatorAuthHook } from './auth.js';
import { eventsRoutes } from './routes/events.js';
import { explainRoutes } from './routes/explain.js';
import { streamRoutes } from './routes/stream.js';
import { incidentRoutes } from './routes/incidents.js';
import { deviceRoutes } from './routes/devices.js';
import { ruleRoutes } from './routes/rules.js';
import { observabilityRoutes } from './routes/observability.js';
import { notificationRoutes } from './routes/notifications.js';

export function buildServer(config: ApiConfig, pool: pg.Pool): FastifyInstance {
  const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });

  const app = fastify({
    genReqId: (req) => {
      const headerId = req.headers['x-correlation-id'] || req.headers['x-request-id'];
      return typeof headerId === 'string' && headerId.length > 0 ? headerId : randomUUID();
    },
    logger: false, // We use custom request logging with pino
    bodyLimit: 5 * 1024 * 1024, // 5MB body size limit
  });

  // Attach structured child logger to each request
  app.addHook('onRequest', async (req) => {
    (req as any).log = logger.child({ correlationId: req.id });
    logger.info(
      {
        correlationId: req.id,
        method: req.method,
        url: req.url,
      },
      'Incoming request'
    );
  });

  // Operator bearer token authentication hook for /api/* operator endpoints
  app.addHook(
    'onRequest',
    createOperatorAuthHook(config.OPERATOR_TOKEN || 'operator-secret-token')
  );

  // Global error handler: ensure malformed bodies/JSON return 400 Bad Request, never 500 or crash
  app.setErrorHandler((error, req, reply) => {
    const statusCode = error.statusCode || 500;

    if (
      error.statusCode === 400 ||
      error instanceof SyntaxError ||
      (error as any).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      (error as any).code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      (error as any).code === '22P02' ||
      (error as any).code === '22007' ||
      (error as any).code === '22008'
    ) {
      return reply.code(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message:
          (error as any).code === '22P02'
            ? 'Invalid parameter syntax or data type (e.g., malformed UUID)'
            : error.message || 'Invalid request body or JSON syntax',
      });
    }

    if (error.statusCode === 413 || (error as any).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Request body exceeds maximum allowed size limit',
      });
    }

    if (statusCode < 500) {
      return reply.code(statusCode).send({
        statusCode,
        error: error.name || 'Bad Request',
        message: error.message,
      });
    }

    logger.error({ err: error, correlationId: req.id }, 'Unhandled server error');
    return reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected internal server error occurred',
    });
  });

  // CORS support for web frontend
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID', 'X-Correlation-ID'],
    exposedHeaders: ['Retry-After', 'X-RateLimit-Remaining'],
  });

  // Response logging with correlation IDs
  app.addHook('onResponse', async (req, reply) => {
    logger.info(
      {
        correlationId: req.id,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      'Request completed'
    );
  });

  // Per-device rate limiter instance
  const rateLimiter = new DeviceRateLimiter(
    config.RATE_LIMIT_MAX_REQUESTS,
    config.RATE_LIMIT_WINDOW_MS
  );

  // Register route modules
  app.register(eventsRoutes, {
    pool,
    rateLimiter,
    queueBackpressureThreshold: config.effectiveMaxPending,
    lateEventWindowSeconds: config.LATE_EVENT_WINDOW_SECONDS,
  });
  app.register(explainRoutes, { pool });
  app.register(streamRoutes, { pool });
  app.register(incidentRoutes, { pool });
  app.register(deviceRoutes, { pool });
  app.register(ruleRoutes, { pool });
  app.register(observabilityRoutes, { pool });
  app.register(notificationRoutes, { pool });

  return app;
}
