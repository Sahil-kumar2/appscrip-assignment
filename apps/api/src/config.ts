import { z } from 'zod';

export const ApiConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/aps'),
  QUEUE_BACKPRESSURE_THRESHOLD: z.coerce.number().int().positive().default(5000),
  MAX_PENDING: z.coerce.number().int().positive().optional(),
  LATE_EVENT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  OPERATOR_TOKEN: z.string().default('operator-secret-token'),
  LOG_LEVEL: z.string().default('info'),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema> & {
  effectiveMaxPending: number;
};

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const result = ApiConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid API Configuration: ${JSON.stringify(result.error.format())}`);
  }
  const effectiveMaxPending = result.data.MAX_PENDING ?? result.data.QUEUE_BACKPRESSURE_THRESHOLD;
  return {
    ...result.data,
    effectiveMaxPending,
  };
}
