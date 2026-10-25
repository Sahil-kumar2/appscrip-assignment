import { z } from 'zod';

/**
 * Standard Environment Configuration Schemas
 */
export const CommonEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aps'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
});
export type CommonEnv = z.infer<typeof CommonEnvSchema>;

export const ApiEnvSchema = CommonEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  QUEUE_BACKPRESSURE_THRESHOLD: z.coerce.number().int().positive().default(5000),
  MAX_PENDING: z.coerce.number().int().positive().optional(),
  LATE_EVENT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  AUTO_MIGRATE: z.coerce.boolean().default(true),
  NOTIFICATION_SINK_URL: z.string().default('http://notification-sink:4000/webhook'),
  OPERATOR_TOKEN: z.string().default('operator-secret-token'),
});
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

export const WorkerEnvSchema = CommonEnvSchema.extend({
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  EVENT_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  MAX_EVENT_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  OUTBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MAX_OUTBOX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  ABSENCE_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  AUTO_MIGRATE: z.coerce.boolean().default(false),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export const NotificationSinkEnvSchema = CommonEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  CHAOS_ENABLED: z.coerce.boolean().default(false),
  CHAOS_STATUS_CODE: z.coerce.number().int().default(503),
});
export type NotificationSinkEnv = z.infer<typeof NotificationSinkEnvSchema>;

/**
 * Universal config loader that validates process.env against any Zod schema.
 * Throws a clean, human-readable error on validation failure.
 */
export function loadConfig<T>(
  schema: z.ZodType<T>,
  env: Record<string, string | undefined> = process.env
): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errorDetails}`);
  }
  return parsed.data;
}
