import { z } from 'zod';

// ==========================================
// Device Schemas
// ==========================================
export const DeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  location_id: z.string().min(1).nullable().optional(),
  key_hash: z.string().min(1),
  status: z.enum(['online', 'offline', 'warning', 'error']).default('offline'),
  last_seen_at: z.coerce.date().nullable().optional(),
  last_event_ts: z.coerce.date().nullable().optional(),
  last_seq: z.number().int().nonnegative().default(0),
  created_at: z.coerce.date().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ==========================================
// Ingest Event Schemas
// Protocol: POST /v1/events
// Batch up to 500, Bearer device key (hashed in DB)
// Event: { event_id: uuid, device_id, seq: int (monotonic per device), ts: ISO8601 UTC, type, payload: object, schema_version: 1 }
// ==========================================
export const IngestEventSchema = z.object({
  event_id: z.string().uuid({ message: 'event_id must be a valid UUID' }),
  device_id: z.string().min(1, { message: 'device_id is required' }),
  seq: z.number().int().nonnegative({ message: 'seq must be a non-negative integer' }),
  ts: z.string().datetime({ message: 'ts must be an ISO 8601 UTC timestamp' }),
  type: z.string().min(1, { message: 'type is required' }),
  payload: z.record(z.any()).default({}),
  schema_version: z.literal(1, {
    errorMap: () => ({ message: 'schema_version must be exactly 1' }),
  }),
});
export type IngestEvent = z.infer<typeof IngestEventSchema>;

export const IngestBatchSchema = z
  .array(z.unknown())
  .min(1, 'Batch must contain at least 1 event')
  .max(500, 'Batch size exceeds maximum limit of 500');

export const IngestResultStatusSchema = z.enum(['accepted', 'duplicate', 'rejected']);
export type IngestResultStatus = z.infer<typeof IngestResultStatusSchema>;

export const IngestEventResultSchema = z.object({
  event_id: z.string(),
  status: IngestResultStatusSchema,
  reason: z.string().optional(),
});
export type IngestEventResult = z.infer<typeof IngestEventResultSchema>;

export const IngestResponseSchema = z.object({
  results: z.array(IngestEventResultSchema),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

// ==========================================
// Stored Event & Processing Status
// ==========================================
export const ProcessingStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;

export const StoredEventSchema = IngestEventSchema.extend({
  id: z.coerce.number().optional(),
  received_at: z.coerce.date(),
  processing_status: ProcessingStatusSchema,
  attempts: z.number().int().nonnegative().default(0),
  locked_until: z.coerce.date().nullable().optional(),
  last_error: z.string().nullable().optional(),
  is_late: z.boolean().default(false),
  created_at: z.coerce.date().optional(),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

// ==========================================
// Rejected Events
// ==========================================
export const RejectedEventSchema = z.object({
  id: z.number().optional(),
  device_id: z.string().nullable().optional(),
  raw_payload: z.any(),
  reason: z.string(),
  rejected_at: z.coerce.date().optional(),
});
export type RejectedEvent = z.infer<typeof RejectedEventSchema>;

// ==========================================
// Rules & Scopes
// ==========================================
export const RuleTypeSchema = z.enum(['threshold', 'event_type', 'absence']);
export type RuleType = z.infer<typeof RuleTypeSchema>;

export const RuleScopeTypeSchema = z.enum(['all', 'location', 'device']);
export type RuleScopeType = z.infer<typeof RuleScopeTypeSchema>;

export const ComparisonOperatorSchema = z.enum(['>', '>=', '<', '<=', '==', '!=']);
export type ComparisonOperator = z.infer<typeof ComparisonOperatorSchema>;

export const ThresholdRuleConfigSchema = z.object({
  field: z.string().min(1),
  operator: ComparisonOperatorSchema,
  value: z.number(),
});
export type ThresholdRuleConfig = z.infer<typeof ThresholdRuleConfigSchema>;

export const EventTypeRuleConfigSchema = z.object({
  event_type: z.string().min(1),
});
export type EventTypeRuleConfig = z.infer<typeof EventTypeRuleConfigSchema>;

export const AbsenceRuleConfigSchema = z.object({
  timeout_seconds: z.number().int().positive().default(60),
});
export type AbsenceRuleConfig = z.infer<typeof AbsenceRuleConfigSchema>;

export const RuleConfigSchema = z.union([
  ThresholdRuleConfigSchema,
  EventTypeRuleConfigSchema,
  AbsenceRuleConfigSchema,
]);

export const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rule_type: RuleTypeSchema.optional(),
  type: RuleTypeSchema.optional(),
  scope_type: RuleScopeTypeSchema.optional(),
  scope_value: z.string().nullable().optional(),
  scope: z.record(z.any()).optional(),
  severity: z.string().default('warning'),
  config: z.record(z.any()),
  enabled: z.boolean().default(true),
  cooldown: z.number().int().default(0),
  created_at: z.coerce.date().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

// ==========================================
// Incidents & Incident History
// States: open -> acknowledged -> resolved | auto_resolved
// ==========================================
export const IncidentStatusSchema = z.enum(['open', 'acknowledged', 'resolved', 'auto_resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentSchema = z.object({
  id: z.string().uuid(),
  dedup_key: z.string().min(1),
  rule_id: z.string().min(1),
  device_id: z.string().min(1),
  status: IncidentStatusSchema,
  severity: z.string().default('warning'),
  opened_at: z.coerce.date().optional(),
  acknowledged_at: z.coerce.date().nullable().optional(),
  resolved_at: z.coerce.date().nullable().optional(),
  occurrence_count: z.number().int().positive().default(1),
  first_seen_at: z.coerce.date().optional(),
  last_seen_at: z.coerce.date().optional(),
  last_event_at: z.coerce.date().optional(),
  last_event_id: z.string().uuid().nullable().optional(),
  summary: z.string().default(''),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const IncidentHistorySchema = z.object({
  id: z.number().optional(),
  incident_id: z.string().uuid(),
  from_status: IncidentStatusSchema.nullable().optional(),
  to_status: IncidentStatusSchema,
  actor: z.string().min(1),
  timestamp: z.coerce.date().optional(),
  reason: z.string().nullable().optional(),
});
export type IncidentHistory = z.infer<typeof IncidentHistorySchema>;

// ==========================================
// Transactional Outbox Notifications
// ==========================================
export const OutboxStatusSchema = z.enum(['pending', 'in_flight', 'delivered', 'failed', 'dead']);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const OutboxNotificationSchema = z.object({
  id: z.string().uuid(),
  incident_id: z.string().uuid(),
  operator_id: z.string().min(1),
  destination_url: z.string().url().optional(),
  payload: z.record(z.any()).optional(),
  status: OutboxStatusSchema.default('pending'),
  attempts: z.number().int().nonnegative().default(0),
  next_attempt_at: z.coerce.date().nullable().optional(),
  last_error: z.string().nullable().optional(),
  created_at: z.coerce.date().optional(),
  updated_at: z.coerce.date().optional(),
});
export type OutboxNotification = z.infer<typeof OutboxNotificationSchema>;

export const NotificationOutboxSchema = OutboxNotificationSchema;
export type NotificationOutbox = OutboxNotification;

// ==========================================
// Change Log & SSE
// ==========================================
export const ChangeLogEntrySchema = z.object({
  seq: z.number().int().positive(),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  action: z.enum(['INSERT', 'UPDATE', 'DELETE']),
  payload: z.record(z.any()),
  created_at: z.coerce.date(),
});
export type ChangeLogEntry = z.infer<typeof ChangeLogEntrySchema>;

// ==========================================
// Explainability: Rule Evaluations
// ==========================================
export const RuleEvaluationSchema = z.object({
  id: z.number().optional(),
  event_id: z.string().uuid(),
  rule_id: z.string().min(1),
  matched: z.boolean(),
  reason: z.string(),
  evaluated_at: z.coerce.date().optional(),
});
export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;

// ==========================================
// Locations & Operators
// ==========================================
export const LocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  metadata: z.record(z.any()).default({}),
  created_at: z.coerce.date().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const OperatorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  webhook_url: z.string().url(),
  location_ids: z.array(z.string()).default([]),
  location_id: z.string().optional(),
  created_at: z.coerce.date().optional(),
});
export type Operator = z.infer<typeof OperatorSchema>;
