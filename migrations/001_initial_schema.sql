-- 001_initial_schema.sql
-- Real-Time Device Operations Platform Schema

-- 1. Locations
CREATE TABLE IF NOT EXISTS locations (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Operators (webhook notifications for assigned locations)
CREATE TABLE IF NOT EXISTS operators (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    webhook_url TEXT NOT NULL,
    location_ids TEXT[] NOT NULL DEFAULT '{}',
    location_id VARCHAR(64), -- backward compatibility
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Devices (id, name, location_id, key_hash, last_seen_at, last_event_ts, created_at)
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    location_id VARCHAR(64) REFERENCES locations(id) ON DELETE SET NULL,
    key_hash VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(32) NOT NULL DEFAULT 'offline',
    last_seen_at TIMESTAMPTZ,
    last_event_ts TIMESTAMPTZ,
    last_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_location ON devices (location_id);

-- 4. Events (id, device_id, event_id, seq, ts, type, payload, received_at, processing_status, attempts, locked_until, last_error, is_late)
CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL,
    event_id UUID NOT NULL,
    device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    type VARCHAR(128) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    schema_version INT NOT NULL DEFAULT 1,
    processing_status VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    last_error TEXT,
    is_late BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_events PRIMARY KEY (device_id, event_id),
    CONSTRAINT uq_events_device_event UNIQUE (device_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_status_received 
    ON events (processing_status, received_at);

CREATE INDEX IF NOT EXISTS idx_events_queue 
    ON events (processing_status, locked_until, received_at) 
    WHERE processing_status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_events_device_seq 
    ON events (device_id, seq);

CREATE INDEX IF NOT EXISTS idx_events_event_id 
    ON events (event_id);

-- 5. Rejected Events
CREATE TABLE IF NOT EXISTS rejected_events (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64),
    raw_payload JSONB,
    reason TEXT NOT NULL,
    rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rejected_events_rejected_at ON rejected_events (rejected_at DESC);

-- Capping trigger for rejected_events (max 10,000 rows)
CREATE OR REPLACE FUNCTION cap_rejected_events_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.id % 50 = 0) THEN
        DELETE FROM rejected_events
        WHERE id IN (
            SELECT id FROM rejected_events
            ORDER BY id ASC
            LIMIT GREATEST(0, (SELECT count(*) - 10000 FROM rejected_events))
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cap_rejected_events ON rejected_events;
CREATE TRIGGER trg_cap_rejected_events
AFTER INSERT ON rejected_events
FOR EACH ROW
EXECUTE FUNCTION cap_rejected_events_trigger();

-- 6. Rules (id, name, type, config jsonb, scope, severity, enabled, cooldown)
CREATE TABLE IF NOT EXISTS rules (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL,
    rule_type VARCHAR(32), -- alias for type
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    scope JSONB NOT NULL DEFAULT '{"type":"all"}'::jsonb,
    scope_type VARCHAR(32) DEFAULT 'all', -- backward compatibility
    scope_value VARCHAR(64),              -- backward compatibility
    severity VARCHAR(32) NOT NULL DEFAULT 'warning',
    enabled BOOLEAN NOT NULL DEFAULT true,
    cooldown INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Incidents (id, rule_id, device_id, dedup_key, status, severity, opened_at, acknowledged_at, resolved_at, occurrence_count, last_event_at, summary)
CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY,
    rule_id VARCHAR(64) NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    dedup_key VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'open',
    severity VARCHAR(32) NOT NULL DEFAULT 'warning',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(), -- alias for opened_at
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),  -- alias for last_event_at
    last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_event_id UUID,
    occurrence_count INT NOT NULL DEFAULT 1,
    summary TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index on dedup_key where status in ('open','acknowledged')
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_active_dedup 
    ON incidents (dedup_key) 
    WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_incidents_device_status 
    ON incidents (device_id, status);

CREATE INDEX IF NOT EXISTS idx_incidents_updated_at 
    ON incidents (updated_at DESC);

-- 8. Incident Events
CREATE TABLE IF NOT EXISTS incident_events (
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (incident_id, event_id)
);

-- 9. Incident History
CREATE TABLE IF NOT EXISTS incident_history (
    id BIGSERIAL PRIMARY KEY,
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    from_status VARCHAR(32),
    to_status VARCHAR(32) NOT NULL,
    actor VARCHAR(128) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_history_incident 
    ON incident_history (incident_id, timestamp ASC);

-- 10. Notification Outbox (id, incident_id, operator_id, status, attempts, next_attempt_at, last_error)
CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY,
    incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    operator_id VARCHAR(64) NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    destination_url TEXT,
    payload JSONB,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_queue 
    ON notification_outbox (status, next_attempt_at, created_at) 
    WHERE status IN ('pending', 'failed');

-- View for backward compatibility if any query references outbox_notifications
CREATE OR REPLACE VIEW outbox_notifications AS SELECT * FROM notification_outbox;

-- 11. Rule Evaluations
CREATE TABLE IF NOT EXISTS rule_evaluations (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL,
    rule_id VARCHAR(64) NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
    matched BOOLEAN NOT NULL,
    reason TEXT NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rule_evaluations_event_id 
    ON rule_evaluations (event_id, evaluated_at DESC);

-- 12. Change Log (seq bigserial, entity, entity_id, op, data jsonb, created_at)
CREATE TABLE IF NOT EXISTS change_log (
    seq BIGSERIAL PRIMARY KEY,
    entity VARCHAR(64),
    entity_id VARCHAR(128) NOT NULL,
    op VARCHAR(32),
    data JSONB DEFAULT '{}'::jsonb,
    entity_type VARCHAR(64),
    action VARCHAR(32),
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION sync_change_log_cols()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.entity IS NULL AND NEW.entity_type IS NOT NULL THEN
        NEW.entity := NEW.entity_type;
    ELSIF NEW.entity_type IS NULL AND NEW.entity IS NOT NULL THEN
        NEW.entity_type := NEW.entity;
    END IF;

    IF NEW.op IS NULL AND NEW.action IS NOT NULL THEN
        NEW.op := NEW.action;
    ELSIF NEW.action IS NULL AND NEW.op IS NOT NULL THEN
        NEW.action := NEW.op;
    END IF;

    IF NEW.data IS NULL AND NEW.payload IS NOT NULL THEN
        NEW.data := NEW.payload;
    ELSIF NEW.payload IS NULL AND NEW.data IS NOT NULL THEN
        NEW.payload := NEW.data;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_change_log_cols ON change_log;
CREATE TRIGGER trg_sync_change_log_cols
BEFORE INSERT ON change_log
FOR EACH ROW
EXECUTE FUNCTION sync_change_log_cols();

CREATE INDEX IF NOT EXISTS idx_change_log_created_at ON change_log (created_at DESC);

-- Trigger on change_log inserts for real-time LISTEN/NOTIFY streaming
CREATE OR REPLACE FUNCTION notify_change_log_insert()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('change_log', json_build_object(
        'seq', NEW.seq,
        'entity', NEW.entity,
        'entity_id', NEW.entity_id,
        'op', NEW.op
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_change_log ON change_log;
CREATE TRIGGER trg_notify_change_log
AFTER INSERT ON change_log
FOR EACH ROW
EXECUTE FUNCTION notify_change_log_insert();

-- Capping trigger for change_log: every 500 inserts, prune entries older than 50,000 sequence IDs
CREATE OR REPLACE FUNCTION cap_change_log_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.seq % 500 = 0) THEN
        DELETE FROM change_log
        WHERE seq < (NEW.seq - 50000);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cap_change_log ON change_log;
CREATE TRIGGER trg_cap_change_log
AFTER INSERT ON change_log
FOR EACH ROW
EXECUTE FUNCTION cap_change_log_trigger();

