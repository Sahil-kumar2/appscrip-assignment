import React, { useState, useMemo } from 'react';
import { Incident, IncidentSeverity } from '../types.js';
import { ActionButton } from './ActionButton.js';
import { formatRelativeTime } from '../utils/incidentGrouping.js';
import { useToast } from './Toast.js';
import {
  ShieldAlert,
  Flame,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Filter,
  AlertTriangle,
  Info,
  Clock,
} from 'lucide-react';

interface IncidentRailProps {
  incidents: Record<string, Incident>;
  selectedIncidentId: string | null;
  onSelectIncident: (id: string) => void;
  onAcknowledge: (id: string) => Promise<boolean>;
  onResolve: (id: string) => Promise<boolean>;
  isOffline: boolean;
  isOpen?: boolean;
  onToggleOpen?: () => void;
}

export const IncidentRail: React.FC<IncidentRailProps> = ({
  incidents,
  selectedIncidentId,
  onSelectIncident,
  onAcknowledge,
  onResolve,
  isOffline,
  isOpen = true,
  onToggleOpen,
}) => {
  const { showToast } = useToast();
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'critical'>('all');
  const [savingId, setSavingId] = useState<string | null>(null);

  // Filter open/acknowledged incidents sorted by severity & timestamp
  const sortedIncidents = useMemo(() => {
    const list = Object.values(incidents).filter(
      (i) => i.status === 'open' || i.status === 'acknowledged'
    );

    const severityWeight: Record<IncidentSeverity, number> = {
      critical: 3,
      warning: 2,
      info: 1,
    };

    return list
      .filter((i) => (filterSeverity === 'critical' ? i.severity === 'critical' : true))
      .sort((a, b) => {
        const diffSev = (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
        if (diffSev !== 0) return diffSev;
        const timeA = new Date(a.last_event_at || a.opened_at || a.created_at || 0).getTime();
        const timeB = new Date(b.last_event_at || b.opened_at || b.created_at || 0).getTime();
        return timeB - timeA;
      });
  }, [incidents, filterSeverity]);

  const totalOpenCount = useMemo(() => {
    return Object.values(incidents).filter(
      (i) => i.status === 'open' || i.status === 'acknowledged'
    ).length;
  }, [incidents]);

  const criticalCount = useMemo(() => {
    return Object.values(incidents).filter(
      (i) => (i.status === 'open' || i.status === 'acknowledged') && i.severity === 'critical'
    ).length;
  }, [incidents]);

  const handleQuickAck = async (e: React.MouseEvent, incident: Incident) => {
    e.stopPropagation();
    setSavingId(incident.id);
    try {
      const ok = await onAcknowledge(incident.id);
      if (ok) {
        showToast('Acknowledged', `${incident.rule_name} (${incident.device_name || incident.device_id})`);
      }
    } finally {
      setSavingId(null);
    }
  };

  const handleQuickResolve = async (e: React.MouseEvent, incident: Incident) => {
    e.stopPropagation();
    setSavingId(incident.id);
    try {
      const ok = await onResolve(incident.id);
      if (ok) {
        showToast('Resolved', `${incident.rule_name} (${incident.device_name || incident.device_id})`);
      }
    } finally {
      setSavingId(null);
    }
  };

  const getSeverityColor = (sev: IncidentSeverity) => {
    switch (sev) {
      case 'critical':
        return 'border-l-[var(--critical)]';
      case 'warning':
        return 'border-l-[var(--stale)]';
      default:
        return 'border-l-[var(--acknowledged)]';
    }
  };

  const getSeverityIcon = (sev: IncidentSeverity) => {
    switch (sev) {
      case 'critical':
        return <AlertTriangle className="w-3.5 h-3.5 text-[var(--critical)] shrink-0" />;
      case 'warning':
        return <AlertTriangle className="w-3.5 h-3.5 text-[var(--stale)] shrink-0" />;
      default:
        return <Info className="w-3.5 h-3.5 text-[var(--acknowledged)] shrink-0" />;
    }
  };

  if (!isOpen) {
    return (
      <aside className="hidden xl:flex flex-col items-center py-4 px-2 w-12 shrink-0 border-l border-[var(--hairline)] bg-[var(--surface)] select-none">
        <button
          onClick={onToggleOpen}
          className="p-1.5 rounded-[var(--radius-control,6px)] hover:bg-[var(--surface-raised)] text-[var(--muted)] hover:text-[var(--ink)] transition mb-4"
          title="Expand Incident Rail"
          aria-label="Expand Incident Rail"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex flex-col items-center space-y-3">
          <ShieldAlert
            className={`w-4 h-4 ${
              criticalCount > 0
                ? 'text-[var(--critical)] animate-pulse'
                : totalOpenCount > 0
                  ? 'text-[var(--stale)]'
                  : 'text-[var(--healthy)]'
            }`}
          />
          <span
            className={`px-1.5 py-0.5 rounded-full font-mono text-[10px] font-bold ${
              criticalCount > 0
                ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                : totalOpenCount > 0
                  ? 'bg-[var(--stale-bg)] text-[var(--stale)]'
                  : 'bg-[var(--healthy-bg)] text-[var(--healthy)]'
            }`}
          >
            {totalOpenCount}
          </span>
          <span className="text-[10px] text-[var(--muted)] font-mono [writing-mode:vertical-lr] tracking-wider uppercase mt-2">
            Incident Rail
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="hidden xl:flex flex-col w-80 shrink-0 border-l border-[var(--hairline)] bg-[var(--surface)] h-full select-none">
      {/* Header */}
      <div className="p-3.5 border-b border-[var(--hairline)] flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <ShieldAlert
            className={`w-4 h-4 ${
              criticalCount > 0
                ? 'text-[var(--critical)]'
                : totalOpenCount > 0
                  ? 'text-[var(--stale)]'
                  : 'text-[var(--healthy)]'
            }`}
          />
          <span className="font-heading font-semibold text-xs tracking-tight text-[var(--ink)]">
            Active Incidents
          </span>
          <span
            className={`px-1.5 py-0.2 rounded-full font-mono text-[10px] font-bold ${
              criticalCount > 0
                ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                : totalOpenCount > 0
                  ? 'bg-[var(--stale-bg)] text-[var(--stale)]'
                  : 'bg-[var(--healthy-bg)] text-[var(--healthy)]'
            }`}
          >
            {totalOpenCount}
          </span>
        </div>

        <div className="flex items-center space-x-1">
          <button
            onClick={() => setFilterSeverity((prev) => (prev === 'all' ? 'critical' : 'all'))}
            className={`px-2 py-0.5 rounded text-[10px] font-mono transition border ${
              filterSeverity === 'critical'
                ? 'bg-[var(--critical-bg)] text-[var(--critical)] border-[var(--critical)]/40 font-bold'
                : 'text-[var(--muted)] border-transparent hover:text-[var(--ink)] hover:bg-[var(--canvas)]'
            }`}
            title="Filter critical only"
          >
            Critical ({criticalCount})
          </button>

          {onToggleOpen && (
            <button
              onClick={onToggleOpen}
              className="p-1 rounded-[var(--radius-control,6px)] hover:bg-[var(--surface-raised)] text-[var(--muted)] hover:text-[var(--ink)] transition"
              title="Collapse Rail"
              aria-label="Collapse Incident Rail"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Incident List */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
        {sortedIncidents.length === 0 ? (
          <div className="py-12 px-4 text-center space-y-2">
            <CheckCircle2 className="w-6 h-6 text-[var(--healthy)] mx-auto" />
            <div className="text-xs font-semibold text-[var(--ink)] font-heading">
              All Clear
            </div>
            <p className="text-[11px] text-[var(--muted)]">
              No active incidents detected. All rules evaluating normally.
            </p>
          </div>
        ) : (
          sortedIncidents.map((inc) => {
            const isSelected = selectedIncidentId === inc.id;
            const relativeTime = formatRelativeTime(inc.last_event_at || inc.opened_at || inc.created_at);
            const isSaving = savingId === inc.id;

            return (
              <div
                key={inc.id}
                onClick={() => onSelectIncident(inc.id)}
                className={`group relative rounded-[var(--radius-control,6px)] border-l-4 ${getSeverityColor(
                  inc.severity
                )} bg-[var(--surface-raised)] border border-[var(--hairline)] p-2.5 cursor-pointer transition shadow-xs hover:border-[var(--muted)]/40 ${
                  isSelected ? 'ring-1 ring-[var(--accent)] border-[var(--accent)]' : ''
                }`}
              >
                {/* Top Row: Rule Name & Age */}
                <div className="flex items-start justify-between gap-1.5">
                  <div className="flex items-center space-x-1.5 min-w-0">
                    {getSeverityIcon(inc.severity)}
                    <span className="font-heading font-semibold text-xs text-[var(--ink)] truncate group-hover:text-[var(--accent)] transition">
                      {inc.rule_name || 'Incident'}
                    </span>
                  </div>

                  <span className="text-[10px] font-mono text-[var(--muted)] shrink-0 whitespace-nowrap">
                    {relativeTime}
                  </span>
                </div>

                {/* Second Row: Device Name & Occurrence badge */}
                <div className="flex items-center justify-between mt-1 text-[11px] text-[var(--muted)]">
                  <span className="font-mono text-[11px] text-[var(--ink)] truncate max-w-[150px]">
                    {inc.device_name || inc.device_id}
                  </span>

                  <div className="flex items-center space-x-1.5">
                    {inc.occurrence_count > 1 && (
                      <span className="inline-flex items-center space-x-0.5 text-[10px] font-mono font-semibold px-1 rounded bg-[var(--stale-bg)] text-[var(--stale)]">
                        <Flame className="w-3 h-3" />
                        <span>{inc.occurrence_count}x</span>
                      </span>
                    )}

                    <span
                      className={`px-1.5 py-0.2 rounded font-mono text-[9px] font-semibold uppercase ${
                        inc.status === 'open'
                          ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                          : 'bg-[var(--acknowledged-bg)] text-[var(--acknowledged)]'
                      }`}
                    >
                      {inc.status}
                    </span>
                  </div>
                </div>

                {/* Third Row: Summary snippet if present */}
                {inc.summary && (
                  <p className="text-[11px] text-[var(--muted)] truncate mt-1">
                    {inc.summary}
                  </p>
                )}

                {/* Quick Actions Row */}
                <div
                  className="mt-2 pt-2 border-t border-[var(--hairline-subtle)] flex items-center justify-between"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-[10px] font-mono text-[var(--muted)]">
                    {isSaving ? 'Saving...' : `#${inc.id.slice(0, 8)}`}
                  </span>

                  <div className="flex items-center space-x-1.5">
                    {inc.status === 'open' && (
                      <ActionButton
                        variant="warning"
                        isOffline={isOffline}
                        className="py-0.5 px-2 text-[10px]"
                        onClick={(e) => handleQuickAck(e, inc)}
                      >
                        Ack
                      </ActionButton>
                    )}

                    <ActionButton
                      variant="secondary"
                      isOffline={isOffline}
                      className="py-0.5 px-2 text-[10px]"
                      onClick={(e) => handleQuickResolve(e, inc)}
                    >
                      Resolve
                    </ActionButton>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Info */}
      <div className="p-2.5 border-t border-[var(--hairline)] bg-[var(--surface-raised)] text-[10px] font-mono text-[var(--muted)] flex items-center justify-between">
        <span>Click card for full explain drawer</span>
        <span>Auto-sorted</span>
      </div>
    </aside>
  );
};
