import React, { useState, useMemo } from 'react';
import { usePlatformStore } from '../store/PlatformContext.js';
import { Incident, IncidentStatus, IncidentSeverity } from '../types.js';
import { ActionButton } from '../components/ActionButton.js';
import { IncidentDetailDrawer } from '../components/IncidentDetailDrawer.js';
import { formatRelativeTime } from '../utils/incidentGrouping.js';
import { useToast } from '../components/Toast.js';
import {
  Search,
  Filter,
  ShieldAlert,
  Flame,
  CheckCircle2,
  Clock,
  ChevronRight,
  AlertTriangle,
  Info,
} from 'lucide-react';

interface IncidentsPageProps {
  onExplainEvent: (eventId: string) => void;
  selectedIncidentId: string | null;
  onSelectIncident: (id: string | null) => void;
}

export const IncidentsPage: React.FC<IncidentsPageProps> = ({
  onExplainEvent,
  selectedIncidentId,
  onSelectIncident,
}) => {
  const { state, acknowledgeIncident, resolveIncident } = usePlatformStore();
  const { incidents, devices, connection } = state;
  const isOffline = connection.status === 'offline';
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [savingId, setSavingId] = useState<string | null>(null);

  const incidentsList = useMemo(() => Object.values(incidents), [incidents]);

  const filteredIncidents = useMemo(() => {
    return incidentsList.filter((inc) => {
      const matchStatus = statusFilter === 'all' || inc.status === statusFilter;
      const matchSeverity = severityFilter === 'all' || inc.severity === severityFilter;
      const matchDevice = deviceFilter === 'all' || inc.device_id === deviceFilter;

      const matchSearch =
        !search ||
        (inc.rule_name || '').toLowerCase().includes(search.toLowerCase()) ||
        (inc.device_name || inc.device_id).toLowerCase().includes(search.toLowerCase()) ||
        (inc.summary || '').toLowerCase().includes(search.toLowerCase());

      return matchStatus && matchSeverity && matchDevice && matchSearch;
    });
  }, [incidentsList, statusFilter, severityFilter, deviceFilter, search]);

  const handleQuickAck = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setSavingId(id);
    try {
      const success = await acknowledgeIncident(id, 'operator:ui', 'Operator acknowledged');
      if (success) {
        showToast('Acknowledged', name);
      }
    } finally {
      setSavingId(null);
    }
  };

  const handleQuickResolve = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    setSavingId(id);
    try {
      const success = await resolveIncident(id, 'operator:ui', 'Operator resolved');
      if (success) {
        showToast('Resolved', name);
      }
    } finally {
      setSavingId(null);
    }
  };

  const getSeverityBadge = (sev: IncidentSeverity) => {
    const isCritical = sev === 'critical';
    const isWarning = sev === 'warning';
    return (
      <span
        className={`inline-flex items-center space-x-1.5 px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase tracking-wider ${
          isCritical
            ? 'bg-[var(--critical-bg)] text-[var(--critical)] border border-[var(--critical)]/30'
            : isWarning
              ? 'bg-[var(--stale-bg)] text-[var(--stale)] border border-[var(--stale)]/30'
              : 'bg-[var(--surface-raised)] text-[var(--acknowledged)] border border-[var(--hairline)]'
        }`}
      >
        {isCritical ? (
          <AlertTriangle className="w-3 h-3 text-[var(--critical)] shrink-0" />
        ) : isWarning ? (
          <AlertTriangle className="w-3 h-3 text-[var(--stale)] shrink-0" />
        ) : (
          <Info className="w-3 h-3 text-[var(--acknowledged)] shrink-0" />
        )}
        <span>{sev}</span>
      </span>
    );
  };

  const getStatusBadge = (status: IncidentStatus) => {
    return (
      <span
        className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold capitalize ${
          status === 'open'
            ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
            : status === 'acknowledged'
              ? 'bg-[var(--acknowledged-bg)] text-[var(--acknowledged)]'
              : 'bg-[var(--healthy-bg)] text-[var(--healthy)]'
        }`}
      >
        {status.replace('_', ' ')}
      </span>
    );
  };

  const getRowSeverityBorder = (sev: IncidentSeverity) => {
    switch (sev) {
      case 'critical':
        return 'border-l-4 border-l-[var(--critical)]';
      case 'warning':
        return 'border-l-4 border-l-[var(--stale)]';
      default:
        return 'border-l-4 border-l-[var(--acknowledged)]';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header and Filter Toolbar */}
      <div>
        <div className="flex items-center space-x-2">
          <ShieldAlert className="w-4 h-4 text-[var(--accent)]" />
          <h1 className="text-xl sm:text-2xl font-heading font-bold tracking-tight text-[var(--ink)]">
            Incident Operations Matrix
          </h1>
        </div>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          Deduplicated fleet incidents backed by transactional outbox webhook notifications
        </p>
      </div>

      <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-4 flex flex-col md:flex-row items-center justify-between gap-4 shadow-xs">
        <div className="w-full md:w-80 relative">
          <Search className="w-4 h-4 text-[var(--muted)] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search incidents, rules, summaries..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-xs text-[var(--ink)] placeholder-[var(--muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto text-xs">
          <div className="flex items-center space-x-1.5 text-[var(--muted)]">
            <Filter className="w-3.5 h-3.5" />
            <span className="font-mono text-[11px] uppercase">Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-[var(--canvas)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] px-2.5 py-1.5 text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono"
            >
              <option value="all">All ({incidentsList.length})</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5 text-[var(--muted)]">
            <span className="font-mono text-[11px] uppercase">Severity:</span>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="bg-[var(--canvas)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] px-2.5 py-1.5 text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono"
            >
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5 text-[var(--muted)]">
            <span className="font-mono text-[11px] uppercase">Device:</span>
            <select
              value={deviceFilter}
              onChange={(e) => setDeviceFilter(e.target.value)}
              className="bg-[var(--canvas)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] px-2.5 py-1.5 text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono max-w-[140px]"
            >
              <option value="all">All devices</option>
              {Object.keys(devices).map((id) => (
                <option key={id} value={id}>
                  {devices[id].name || id}
                </option>
              ))}
            </select>
          </div>

          <div className="text-[var(--muted)] text-xs font-mono ml-auto">
            Showing <span className="font-bold text-[var(--ink)]">{filteredIncidents.length}</span> incidents
          </div>
        </div>
      </div>

      {/* Incidents Table with Accessibility Severity Left Bar */}
      <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[var(--surface-raised)] border-b border-[var(--hairline)] text-[var(--muted)] text-[11px] font-mono font-medium">
              <tr>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Severity</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Status</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Alert Rule</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Device</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Occurrences</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Age</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline)]">
              {filteredIncidents.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-[var(--muted)] font-mono">
                    No incidents match the specified filter criteria.
                  </td>
                </tr>
              ) : (
                filteredIncidents.map((incident) => {
                  const relativeAge = formatRelativeTime(incident.last_event_at || incident.created_at);
                  const isSaving = savingId === incident.id;

                  return (
                    <tr
                      key={incident.id}
                      onClick={() => onSelectIncident(incident.id)}
                      className={`hover:bg-[var(--surface-raised)] transition cursor-pointer group ${getRowSeverityBorder(
                        incident.severity
                      )}`}
                    >
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {getSeverityBadge(incident.severity)}
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {getStatusBadge(incident.status)}
                      </td>

                      <td className="px-5 py-3.5 max-w-sm">
                        <div className="font-heading font-semibold text-[var(--ink)] group-hover:text-[var(--accent)] transition">
                          {incident.rule_name || 'System alert'}
                        </div>
                        {incident.summary && (
                          <div className="text-xs text-[var(--muted)] truncate mt-0.5 font-mono">
                            {incident.summary}
                          </div>
                        )}
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <div className="font-medium text-[var(--ink)]">
                          {incident.device_name || incident.device_id}
                        </div>
                        <div className="text-[11px] text-[var(--muted)] font-mono">{incident.device_id}</div>
                      </td>

                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <span className="inline-flex items-center space-x-1 font-mono text-xs text-[var(--muted)]">
                          <Flame className="w-3.5 h-3.5 text-[var(--stale)]" />
                          <span className="font-semibold text-[var(--ink)]">{incident.occurrence_count}</span>
                        </span>
                      </td>

                      <td className="px-5 py-3.5 text-[var(--muted)] font-mono whitespace-nowrap">
                        <span title={incident.last_event_at ? new Date(incident.last_event_at).toLocaleString() : ''}>
                          {relativeAge}
                        </span>
                      </td>

                      <td
                        className="px-5 py-3.5 text-right space-x-2 whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isSaving ? (
                          <span className="text-[11px] font-mono text-[var(--muted)]">Saving...</span>
                        ) : (
                          <>
                            {incident.status === 'open' && (
                              <ActionButton
                                variant="warning"
                                isOffline={isOffline}
                                className="py-1 px-2.5 text-xs font-mono"
                                onClick={(e) => handleQuickAck(e, incident.id, incident.rule_name)}
                              >
                                Acknowledge
                              </ActionButton>
                            )}

                            {incident.status !== 'resolved' && incident.status !== 'auto_resolved' && (
                              <ActionButton
                                variant="secondary"
                                isOffline={isOffline}
                                className="py-1 px-2.5 text-xs font-mono"
                                onClick={(e) => handleQuickResolve(e, incident.id, incident.rule_name)}
                              >
                                Resolve
                              </ActionButton>
                            )}
                          </>
                        )}

                        <button
                          onClick={() => onSelectIncident(incident.id)}
                          className="p-1 rounded-[var(--radius-control,6px)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--canvas)] transition align-middle"
                          aria-label="View incident details"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Incident Detail Wide Slide-Over Drawer */}
      {selectedIncidentId && (
        <IncidentDetailDrawer
          incidentId={selectedIncidentId}
          isOffline={isOffline}
          onClose={() => onSelectIncident(null)}
          onAcknowledge={(id) =>
            acknowledgeIncident(id, 'operator:ui', 'Acknowledged from drawer')
          }
          onResolve={(id) =>
            resolveIncident(id, 'operator:ui', 'Resolved from drawer')
          }
          onExplainEvent={onExplainEvent}
        />
      )}
    </div>
  );
};
