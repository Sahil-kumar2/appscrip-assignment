export type IncidentStatus = 'open' | 'acknowledged' | 'resolved' | 'auto_resolved';
export type IncidentSeverity = 'critical' | 'warning' | 'info';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'dead';
export type DeviceStatus = 'online' | 'stale' | 'offline' | 'unknown';
export type RuleType = 'threshold' | 'absence' | 'event_type';

export interface Incident {
  id: string;
  rule_id: string;
  rule_name: string;
  rule_type: string;
  rule_config?: any;
  device_id: string;
  device_name: string;
  location_id?: string;
  dedup_key: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  occurrence_count: number;
  opened_at?: string;
  first_seen_at?: string;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  last_seen_at?: string;
  last_event_at?: string;
  last_event_id?: string;
  summary?: string;
  notification_status?: NotificationStatus;
  attached_events_count?: number;
  updated_at?: string;
  created_at?: string;
}

export interface IncidentHistoryItem {
  id: number;
  incident_id?: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  timestamp?: string;
  created_at?: string;
  reason: string;
}

export interface Device {
  id: string;
  name: string;
  location_id: string;
  location_name?: string;
  status: DeviceStatus;
  last_seen_at?: string | null;
  last_event_ts?: string | null;
  last_seq: number;
  created_at?: string;
}

export interface Rule {
  id: string;
  name: string;
  type: RuleType;
  rule_type: RuleType;
  config: any;
  scope: any;
  scope_type: 'all' | 'location' | 'device';
  scope_value?: string | null;
  severity: IncidentSeverity;
  enabled: boolean;
  cooldown: number;
  created_at?: string;
}

export interface StreamChangeLogItem {
  seq: number;
  entity: string;
  entity_id: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  data: any;
  entity_type?: string;
  action?: string;
  payload?: any;
  created_at: string;
}

export type StreamEvent = StreamChangeLogItem;

export interface LiveEventItem {
  id: string;
  event_id: string;
  device_id: string;
  seq: number;
  ts: string;
  received_at: string;
  type: string;
  payload: any;
  processing_status: string;
  is_late?: boolean;
  is_duplicate?: boolean;
}

export interface ExplainData {
  event: {
    id?: number;
    event_id: string;
    device_id: string;
    seq: number;
    ts: string;
    received_at: string;
    type: string;
    payload: any;
    processing_status: string;
    attempts: number;
    last_error?: string | null;
  };
  evaluations: Array<{
    id: number;
    rule_id: string;
    rule_name: string;
    rule_type: string;
    matched: boolean;
    reason: string;
    decision?: 'created' | 'suppressed' | 'not_matched' | string;
    decision_explanation?: string;
    evaluated_at: string;
  }>;
  explanation_summary?: string;
  triggered_incidents?: Array<{
    id: string;
    status: IncidentStatus;
    severity: IncidentSeverity;
    summary: string;
  }>;
}

export interface SystemStats {
  events_per_minute: number;
  devices_by_status: {
    total: number;
    online: number;
    stale: number;
    offline: number;
    unknown: number;
  };
  open_incidents_by_severity: {
    total_open: number;
    critical: number;
    warning: number;
    info: number;
  };
  queue_depth_and_lag: {
    depth: number;
    pending_depth?: number;
    lag_seconds: number;
    pending: number;
    processing: number;
    done: number;
    failed: number;
  };
  failed_events: {
    failed_count: number;
    rejected_count: number;
  };
  outbox_state: {
    total: number;
    pending: number;
    in_flight: number;
    sent: number;
    failed: number;
    dead: number;
  };
}

export interface DeadLetterItem {
  event_id?: string;
  id?: string;
  device_id?: string;
  seq?: number;
  type?: string;
  attempts?: number;
  last_error?: string | null;
  received_at?: string;
  reason?: string;
  error?: string;
}

export interface OutboxItem {
  id: string;
  incident_id: string;
  operator_id: string;
  destination_url: string;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: string;
  last_error?: string | null;
  created_at: string;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  offlineSince: Date | null;
  isStale: boolean;
  lastSeq: number;
}
