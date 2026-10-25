import { Incident, IncidentSeverity, IncidentStatus } from '../types.js';

export interface GroupedIncident {
  key: string; // rule_id:device_id
  primaryId: string;
  rule_id: string;
  rule_name: string;
  rule_type?: string;
  device_id: string;
  device_name: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  occurrence_count: number;
  last_event_at?: string;
  age: string;
  summary?: string;
  incidentIds: string[];
  incidents: Incident[];
}

export function formatRelativeTime(dateInput?: string | Date | null): string {
  if (!dateInput) return 'recently';
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const now = new Date();
  const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));

  if (diffSec < 45) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

const severityRank: Record<IncidentSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

const statusRank: Record<IncidentStatus, number> = {
  open: 3,
  acknowledged: 2,
  resolved: 1,
  auto_resolved: 1,
};

/**
 * Groups an array of incidents by (rule_id:device_id) deduplication key.
 * Aggregates occurrences, picks the most urgent severity/status, and calculates relative age.
 */
export function groupIncidents(incidents: Incident[]): GroupedIncident[] {
  const map = new Map<string, GroupedIncident>();

  for (const inc of incidents) {
    const key = inc.dedup_key || `${inc.rule_id}:${inc.device_id}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        key,
        primaryId: inc.id,
        rule_id: inc.rule_id,
        rule_name: inc.rule_name || inc.rule_id,
        rule_type: inc.rule_type,
        device_id: inc.device_id,
        device_name: inc.device_name || inc.device_id,
        severity: inc.severity,
        status: inc.status,
        occurrence_count: inc.occurrence_count || 1,
        last_event_at: inc.last_event_at || inc.created_at || inc.updated_at,
        age: formatRelativeTime(inc.last_event_at || inc.created_at || inc.updated_at),
        summary: inc.summary,
        incidentIds: [inc.id],
        incidents: [inc],
      });
    } else {
      existing.incidentIds.push(inc.id);
      existing.incidents.push(inc);

      // Aggregate occurrences
      existing.occurrence_count = Math.max(
        existing.occurrence_count + (inc.occurrence_count || 1),
        inc.occurrence_count || 1
      );

      // Pick highest severity
      if (severityRank[inc.severity] > severityRank[existing.severity]) {
        existing.severity = inc.severity;
      }

      // If any is open, group is open; if existing was resolved but new is ack, upgrade to ack
      if (statusRank[inc.status] > statusRank[existing.status]) {
        existing.status = inc.status;
        existing.primaryId = inc.id; // Target active incident for actions
      }

      // Pick newest timestamp
      const existingTime = existing.last_event_at ? new Date(existing.last_event_at).getTime() : 0;
      const incTime = (inc.last_event_at || inc.created_at)
        ? new Date(inc.last_event_at || inc.created_at!).getTime()
        : 0;

      if (incTime > existingTime) {
        existing.last_event_at = inc.last_event_at || inc.created_at;
        existing.age = formatRelativeTime(existing.last_event_at);
        if (inc.summary) existing.summary = inc.summary;
      }
    }
  }

  // Sort groups: open critical > open warning > open info > acknowledged > resolved > by timestamp
  return Array.from(map.values()).sort((a, b) => {
    const statusDiff = statusRank[b.status] - statusRank[a.status];
    if (statusDiff !== 0) return statusDiff;

    const sevDiff = severityRank[b.severity] - severityRank[a.severity];
    if (sevDiff !== 0) return sevDiff;

    const timeA = a.last_event_at ? new Date(a.last_event_at).getTime() : 0;
    const timeB = b.last_event_at ? new Date(b.last_event_at).getTime() : 0;
    return timeB - timeA;
  });
}
