import { z } from 'zod';

export const WorkerConfigSchema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aps'),
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
  LOG_LEVEL: z.string().default('info'),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env
): WorkerConfig {
  const result = WorkerConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid Worker Configuration: ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}
