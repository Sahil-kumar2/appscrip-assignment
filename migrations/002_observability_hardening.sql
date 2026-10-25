-- 002_observability_hardening.sql
-- Observability Hardening: Circuit Breaker States and Execution Telemetry

CREATE TABLE IF NOT EXISTS circuit_breaker_states (
    host VARCHAR(255) PRIMARY KEY,
    state VARCHAR(32) NOT NULL DEFAULT 'CLOSED',
    failure_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for dead-letter diagnostics and queue lag
CREATE INDEX IF NOT EXISTS idx_events_failed_attempts 
    ON events (processing_status, attempts) 
    WHERE processing_status = 'failed';

-- Index for rule evaluations by event
CREATE INDEX IF NOT EXISTS idx_rule_evaluations_event_matched 
    ON rule_evaluations (event_id, matched);
