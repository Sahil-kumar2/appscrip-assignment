import client from 'prom-client';

export const register = new client.Registry();

// Enable default Node.js process metrics
client.collectDefaultMetrics({ register, prefix: 'aps_' });

// 1. Ingest accepted/duplicate/rejected counters
export const eventsIngestedCounter = new client.Counter({
  name: 'aps_events_ingested_total',
  help: 'Total number of events ingested categorized by status (accepted, duplicate, rejected)',
  labelNames: ['status'],
  registers: [register],
});

// 2. 429 backpressure and rate limiting count
export const requests429Counter = new client.Counter({
  name: 'aps_requests_429_total',
  help: 'Total 429 Too Many Requests responses emitted by reason (queue_backpressure, rate_limit)',
  labelNames: ['reason'],
  registers: [register],
});

export const backpressureCounter = new client.Counter({
  name: 'aps_backpressure_rejections_total',
  help: 'Total requests rejected due to queue backpressure',
  registers: [register],
});

export const rateLimitCounter = new client.Counter({
  name: 'aps_rate_limit_rejections_total',
  help: 'Total requests rejected due to per-device rate limiting',
  labelNames: ['device_id'],
  registers: [register],
});

// 3. Queue depth gauge by status
export const queueDepthGauge = new client.Gauge({
  name: 'aps_queue_depth',
  help: 'Current number of events in queue by status (pending, processing, done, failed)',
  labelNames: ['status'],
  registers: [register],
});

// 4. Processing latency histogram
export const eventProcessingDurationHistogram = new client.Histogram({
  name: 'aps_event_processing_duration_seconds',
  help: 'Processing latency duration of events in seconds',
  labelNames: ['status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// 5. Processing attempts and failures
export const eventProcessingAttemptsGauge = new client.Gauge({
  name: 'aps_event_processing_attempts_total',
  help: 'Cumulative count of event processing attempts across queue',
  registers: [register],
});

export const eventProcessingFailuresGauge = new client.Gauge({
  name: 'aps_event_processing_failures_total',
  help: 'Current count of dead-lettered events (processing_status = failed)',
  registers: [register],
});

// 6. Incidents by state gauge
export const incidentsByStateGauge = new client.Gauge({
  name: 'aps_incidents_by_state',
  help: 'Current count of incidents categorized by state (open, acknowledged, resolved, auto_resolved)',
  labelNames: ['state'],
  registers: [register],
});

export const incidentsGauge = new client.Gauge({
  name: 'aps_incidents_total',
  help: 'Current count of incidents by status (backward compatibility alias)',
  labelNames: ['status'],
  registers: [register],
});

// 7. Notification outbox by status
export const outboxByStatusGauge = new client.Gauge({
  name: 'aps_notification_outbox_by_status',
  help: 'Current count of notifications in outbox by status (pending, in_flight, sent, failed, dead)',
  labelNames: ['status'],
  registers: [register],
});

export const outboxNotificationsCounter = new client.Counter({
  name: 'aps_outbox_notifications_total',
  help: 'Total outbox notifications processed (backward compatibility alias)',
  labelNames: ['status'],
  registers: [register],
});

// 8. SSE streaming active clients count
export const sseActiveClientsGauge = new client.Gauge({
  name: 'aps_sse_active_clients',
  help: 'Number of active Server-Sent Events (SSE) streaming clients connected',
  registers: [register],
});

// 9. Circuit breaker state gauge (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'aps_circuit_breaker_state',
  help: 'Current circuit breaker state per webhook host (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)',
  labelNames: ['host'],
  registers: [register],
});
