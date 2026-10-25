import { z } from 'zod';

export const SimulatorConfigSchema = z.object({
  API_URL: z.string().default('http://localhost:3000'),
  INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  BATCH_SIZE: z.coerce.number().int().positive().default(3),
  ANOMALY_PROBABILITY: z.coerce.number().min(0).max(1).default(0.15),
  DUPLICATE_PROBABILITY: z.coerce.number().min(0).max(1).default(0.1),
  MALFORMED_PROBABILITY: z.coerce.number().min(0).max(1).default(0.05),
  LOG_LEVEL: z.string().default('info'),
});

export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;

export function loadSimulatorConfig(
  env: Record<string, string | undefined> = process.env
): SimulatorConfig {
  const result = SimulatorConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid Simulator Configuration: ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}
