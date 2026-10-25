import { FastifyPluginAsync } from 'fastify';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '@aps/shared';

const logger = createLogger({ service: 'rule-routes' });

export interface RuleRouteOptions {
  pool: pg.Pool;
}

export const ThresholdConfigSchema = z.object({
  field: z.string().min(1, 'field is required'),
  operator: z.enum(['>', '>=', '<', '<=', '==', '!=']),
  value: z.number({ required_error: 'value must be a number' }),
  event_type: z.string().optional(),
});

export const AbsenceConfigSchema = z.object({
  timeout_seconds: z.coerce.number().int().positive('timeout_seconds must be a positive integer'),
});

export const EventTypeConfigSchema = z.object({
  event_type: z.string().min(1, 'event_type is required'),
  payload_pattern: z.record(z.any()).optional(),
});

export const CreateRuleSchema = z.discriminatedUnion('rule_type', [
  z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1, 'name is required'),
    rule_type: z.literal('threshold'),
    scope_type: z.enum(['all', 'location', 'device']).default('all'),
    scope_value: z.string().nullable().optional(),
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),
    enabled: z.boolean().default(true),
    cooldown: z.number().int().nonnegative().default(0),
    config: ThresholdConfigSchema,
  }),
  z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1, 'name is required'),
    rule_type: z.literal('absence'),
    scope_type: z.enum(['all', 'location', 'device']).default('all'),
    scope_value: z.string().nullable().optional(),
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),
    enabled: z.boolean().default(true),
    cooldown: z.number().int().nonnegative().default(0),
    config: AbsenceConfigSchema,
  }),
  z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1, 'name is required'),
    rule_type: z.literal('event_type'),
    scope_type: z.enum(['all', 'location', 'device']).default('all'),
    scope_value: z.string().nullable().optional(),
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),
    enabled: z.boolean().default(true),
    cooldown: z.number().int().nonnegative().default(0),
    config: EventTypeConfigSchema,
  }),
]);

export function validateRuleConfig(ruleType: string, config: any) {
  switch (ruleType) {
    case 'threshold':
      return ThresholdConfigSchema.safeParse(config);
    case 'absence':
      return AbsenceConfigSchema.safeParse(config);
    case 'event_type':
      return EventTypeConfigSchema.safeParse(config);
    default:
      return {
        success: false as const,
        error: new Error(
          `Unknown rule_type '${ruleType}'. Must be threshold, absence, or event_type`
        ),
      };
  }
}

export const ruleRoutes: FastifyPluginAsync<RuleRouteOptions> = async (fastify, opts) => {
  const { pool } = opts;

  // List all rules
  fastify.get('/api/rules', async (req) => {
    const query = req.query as { enabled?: string };
    const params: any[] = [];
    let sql = 'SELECT * FROM rules WHERE 1=1';

    if (typeof query.enabled === 'string') {
      params.push(query.enabled === 'true');
      sql += ` AND enabled = $${params.length}`;
    }

    sql += ' ORDER BY created_at ASC';
    const res = await pool.query(sql, params);
    return { rules: res.rows };
  });

  // Get rule by ID
  fastify.get('/api/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await pool.query('SELECT * FROM rules WHERE id = $1', [id]);

    if (res.rows.length === 0) {
      return reply.code(404).send({ error: `Rule '${id}' not found` });
    }

    return { rule: res.rows[0] };
  });

  // Create rule with Zod-validated config per rule type
  fastify.post('/api/rules', async (req, reply) => {
    const rawBody = (req.body as any) || {};

    // Normalize type/rule_type
    const normalizedBody = {
      ...rawBody,
      rule_type: rawBody.rule_type || rawBody.type,
      scope_type: rawBody.scope_type || rawBody.scope?.type || 'all',
      scope_value: rawBody.scope_value || rawBody.scope?.value || null,
    };

    const parsed = CreateRuleSchema.safeParse(normalizedBody);
    if (!parsed.success) {
      return reply.code(400).send({
        error: `Validation error: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
      });
    }

    const r = parsed.data;
    const ruleId = r.id || `rule-${r.rule_type}-${randomUUID().substring(0, 8)}`;

    const res = await pool.query(
      `INSERT INTO rules (id, name, type, rule_type, scope_type, scope_value, scope, config, severity, enabled, cooldown, created_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, NOW())
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           type = EXCLUDED.type,
           rule_type = EXCLUDED.rule_type,
           scope_type = EXCLUDED.scope_type,
           scope_value = EXCLUDED.scope_value,
           scope = EXCLUDED.scope,
           config = EXCLUDED.config,
           severity = EXCLUDED.severity,
           enabled = EXCLUDED.enabled,
           cooldown = EXCLUDED.cooldown
       RETURNING *`,
      [
        ruleId,
        r.name,
        r.rule_type,
        r.scope_type,
        r.scope_value ?? null,
        JSON.stringify({ type: r.scope_type, value: r.scope_value ?? null }),
        JSON.stringify(r.config),
        r.severity,
        r.enabled,
        r.cooldown,
      ]
    );

    // Record change log
    await pool.query(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('rule', $1, 'INSERT', $2::jsonb)`,
      [ruleId, JSON.stringify(res.rows[0])]
    );

    logger.info({ ruleId, name: r.name, ruleType: r.rule_type }, 'Rule created/updated');
    return reply.code(201).send({ status: 'created', rule: res.rows[0] });
  });

  // Patch rule
  fastify.patch('/api/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body as any) || {};

    const existingRes = await pool.query('SELECT * FROM rules WHERE id = $1', [id]);
    if (existingRes.rows.length === 0) {
      return reply.code(404).send({ error: `Rule '${id}' not found` });
    }

    const existingRule = existingRes.rows[0];
    const ruleType = existingRule.rule_type || existingRule.type;

    const updates: string[] = [];
    const params: any[] = [id];

    if (typeof body.name === 'string') {
      params.push(body.name);
      updates.push(`name = $${params.length}`);
    }

    if (typeof body.enabled === 'boolean') {
      params.push(body.enabled);
      updates.push(`enabled = $${params.length}`);
    }

    if (body.severity && ['info', 'warning', 'critical'].includes(body.severity)) {
      params.push(body.severity);
      updates.push(`severity = $${params.length}`);
    }

    if (typeof body.cooldown === 'number') {
      params.push(body.cooldown);
      updates.push(`cooldown = $${params.length}`);
    }

    // Validate config if passed
    if (body.config) {
      const configValidation = validateRuleConfig(ruleType, body.config);
      if (!configValidation.success) {
        return reply.code(400).send({
          error: `Invalid config for rule_type '${ruleType}': ${(configValidation as any).error.message || 'Validation failed'}`,
        });
      }
      params.push(JSON.stringify(configValidation.data));
      updates.push(`config = $${params.length}::jsonb`);
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No fields to update' });
    }

    const res = await pool.query(
      `UPDATE rules SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );

    // Record change log
    await pool.query(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('rule', $1, 'UPDATE', $2::jsonb)`,
      [id, JSON.stringify(res.rows[0])]
    );

    logger.info({ ruleId: id }, 'Rule updated');
    return { rule: res.rows[0] };
  });

  // Delete rule
  fastify.delete('/api/rules/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const checkRes = await pool.query('SELECT id, name FROM rules WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ error: `Rule '${id}' not found` });
    }

    await pool.query('DELETE FROM rules WHERE id = $1', [id]);

    await pool.query(
      `INSERT INTO change_log (entity, entity_id, op, data)
       VALUES ('rule', $1, 'DELETE', $2::jsonb)`,
      [id, JSON.stringify({ id, name: checkRes.rows[0].name })]
    );

    logger.info({ ruleId: id }, 'Rule deleted');
    return { status: 'deleted', deleted: true, id };
  });
};
