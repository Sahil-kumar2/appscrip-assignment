import React, { useState, useEffect } from 'react';
import { Incident, IncidentHistoryItem } from '../types.js';
import { authFetch } from '../api.js';
import { ActionButton } from './ActionButton.js';
import { useToast } from './Toast.js';
import {
  X,
  ShieldAlert,
  Flame,
  Clock,
  Send,
  HelpCircle,
  Cpu,
  History,
  CheckCircle2,
  RefreshCw,
  Bell,
  AlertTriangle,
  Check,
  Ban,
  Activity,
  ArrowRight,
} from 'lucide-react';

interface IncidentDetailDrawerProps {
  incidentId: string | null;
  isOffline: boolean;
  onClose: () => void;
  onAcknowledge: (id: string) => Promise<boolean>;
  onResolve: (id: string) => Promise<boolean>;
  onExplainEvent: (eventId: string) => void;
}

export const IncidentDetailDrawer: React.FC<IncidentDetailDrawerProps> = ({
  incidentId,
  isOffline,
  onClose,
  onAcknowledge,
  onResolve,
  onExplainEvent,
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'explain' | 'events' | 'timeline' | 'notifications'>('overview');
  const [data, setData] = useState<{
    incident: Incident;
    events: Array<{
      event_id: string;
      seq: number;
      ts: string;
      type: string;
      payload: any;
      attached_at: string;
    }>;
    history: IncidentHistoryItem[];
    notifications: any[];
    rule_evaluations: any[];
  } | null>(null);

  const [retryingNotif, setRetryingNotif] = useState<boolean>(false);
  const { showToast } = useToast();

  const fetchDetail = () => {
    if (!incidentId) return;
    setLoading(true);
    authFetch(`/api/incidents/${incidentId}`)
      .then((res) => {
        if (!res.ok) throw new Error('Incident not found');
        return res.json();
      })
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchDetail();
  }, [incidentId]);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!incidentId) return null;

  const incident = data?.incident;

  const handleRetryNotification = async () => {
    setRetryingNotif(true);
    try {
      const res = await authFetch(`/api/incidents/${incidentId}/retry-notifications`, { method: 'POST' });
      if (res.ok) {
        showToast('Retried', 'Notification redelivery initiated');
        fetchDetail();
      }
    } finally {
      setRetryingNotif(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end"
      onClick={onClose}
    >
      <div
        className="bg-[var(--surface)] border-l border-[var(--hairline)] w-full max-w-2xl h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="px-6 py-4 border-b border-[var(--hairline)] bg-[var(--surface-raised)] flex items-start justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded-[var(--radius-control,6px)] font-mono text-[10px] font-bold uppercase tracking-wider ${
                  incident?.severity === 'critical'
                    ? 'bg-[var(--critical-bg)] text-[var(--critical)] border border-[var(--critical)]/30'
                    : incident?.severity === 'warning'
                      ? 'bg-[var(--stale-bg)] text-[var(--stale)] border border-[var(--stale)]/30'
                      : 'bg-[var(--surface)] text-[var(--muted)] border border-[var(--hairline)]'
                }`}
              >
                {incident?.severity || 'warning'}
              </span>

              <span className="px-2 py-0.5 rounded-[var(--radius-control,6px)] font-mono text-[10px] font-semibold capitalize bg-[var(--surface)] text-[var(--ink)] border border-[var(--hairline)]">
                {incident?.status?.replace('_', ' ') || 'open'}
              </span>

              {incident && incident.occurrence_count > 1 && (
                <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-[var(--radius-control,6px)] bg-[var(--stale-bg)] text-[var(--stale)] font-mono text-[10px] font-bold">
                  <Flame className="w-3 h-3" />
                  <span>{incident.occurrence_count} occurrences</span>
                </span>
              )}
            </div>

            <h2 className="font-heading font-bold text-base text-[var(--ink)] truncate">
              {incident?.rule_name || 'Incident Details'}
            </h2>

            <div className="text-xs text-[var(--muted)] font-mono">
              Target: <span className="text-[var(--ink)] font-semibold">{incident?.device_name || incident?.device_id}</span> ({incident?.device_id})
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-[var(--radius-control,6px)] hover:bg-[var(--canvas)] text-[var(--muted)] hover:text-[var(--ink)] transition shrink-0"
            aria-label="Close drawer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick Action Bar */}
        <div className="px-6 py-2.5 border-b border-[var(--hairline)] bg-[var(--canvas)] flex items-center justify-between">
          <div className="text-[11px] font-mono text-[var(--muted)]">
            Incident ID: <span className="text-[var(--ink)] select-all">{incidentId}</span>
          </div>

          <div className="flex items-center space-x-2">
            {incident?.status === 'open' && (
              <ActionButton
                isOffline={isOffline}
                variant="warning"
                onClick={async () => {
                  const success = await onAcknowledge(incidentId);
                  if (success) {
                    showToast('Acknowledged', incident.rule_name);
                    fetchDetail();
                  }
                }}
              >
                Acknowledge
              </ActionButton>
            )}

            {(incident?.status === 'open' || incident?.status === 'acknowledged') && (
              <ActionButton
                isOffline={isOffline}
                variant="secondary"
                onClick={async () => {
                  const success = await onResolve(incidentId);
                  if (success) {
                    showToast('Resolved', incident.rule_name);
                    fetchDetail();
                  }
                }}
              >
                Resolve
              </ActionButton>
            )}
          </div>
        </div>

        {/* Drawer Tabs */}
        <div className="flex border-b border-[var(--hairline)] px-6 space-x-4 text-xs font-medium overflow-x-auto bg-[var(--surface)]">
          {[
            { id: 'overview', label: 'Summary' },
            { id: 'explain', label: 'Why did this fire?' },
            { id: 'events', label: `Matched Events (${data?.events?.length || 0})` },
            { id: 'timeline', label: `Timeline (${data?.history?.length || 0})` },
            { id: 'notifications', label: 'Notifications' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`py-3 border-b-2 transition whitespace-nowrap font-heading ${
                activeTab === tab.id
                  ? 'border-[var(--accent)] text-[var(--accent)] font-bold'
                  : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {loading ? (
            <div className="text-center py-16 text-[var(--muted)] font-mono">
              Loading incident telemetry context...
            </div>
          ) : !incident ? (
            <div className="text-center py-16 text-[var(--critical)]">
              Unable to load incident details.
            </div>
          ) : (
            <>
              {/* Tab 1: Overview Summary */}
              {activeTab === 'overview' && (
                <div className="space-y-4">
                  <div className="bg-[var(--surface-raised)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-[11px] font-mono text-[var(--muted)] uppercase">Device</div>
                        <div className="text-sm font-semibold text-[var(--ink)] mt-0.5">
                          {incident.device_name || incident.device_id}
                        </div>
                        <div className="text-xs text-[var(--muted)] font-mono">{incident.device_id}</div>
                      </div>

                      <div>
                        <div className="text-[11px] font-mono text-[var(--muted)] uppercase">Rule</div>
                        <div className="text-sm font-semibold text-[var(--ink)] mt-0.5">
                          {incident.rule_name}
                        </div>
                        <div className="text-xs text-[var(--muted)] capitalize">
                          Type: {incident.rule_type}
                        </div>
                      </div>
                    </div>

                    {incident.summary && (
                      <div className="pt-3 border-t border-[var(--hairline)]">
                        <div className="text-[11px] font-mono text-[var(--muted)] uppercase">Condition Summary</div>
                        <p className="text-xs text-[var(--ink)] mt-1 font-mono bg-[var(--surface)] p-2 rounded border border-[var(--hairline)]">
                          {incident.summary}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 font-mono text-xs">
                    <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-panel,8px)] border border-[var(--hairline)]">
                      <div className="text-[11px] text-[var(--muted)] uppercase">Opened At</div>
                      <div className="text-xs font-semibold text-[var(--ink)] mt-1">
                        {incident.opened_at || incident.created_at
                          ? new Date(incident.opened_at || incident.created_at!).toLocaleString()
                          : 'N/A'}
                      </div>
                    </div>

                    <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-panel,8px)] border border-[var(--hairline)]">
                      <div className="text-[11px] text-[var(--muted)] uppercase">Last Occurrence</div>
                      <div className="text-xs font-semibold text-[var(--ink)] mt-1">
                        {incident.last_event_at
                          ? new Date(incident.last_event_at).toLocaleString()
                          : 'N/A'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Why Did This Fire? (Readable Checklist Style) */}
              {activeTab === 'explain' && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-heading font-semibold text-xs text-[var(--ink)]">
                      Rule Evaluation Checklist
                    </h3>
                    <p className="text-[11px] text-[var(--muted)] mt-0.5">
                      Transparent checklist showing conditions checked against incoming telemetry values.
                    </p>
                  </div>

                  {data?.rule_evaluations && data.rule_evaluations.length > 0 ? (
                    <div className="space-y-3">
                      {data.rule_evaluations.map((evalItem: any) => {
                        const isMatched = evalItem.matched || evalItem.decision === 'created' || evalItem.decision === 'suppressed';
                        return (
                          <div
                            key={evalItem.id}
                            className={`p-4 rounded-[var(--radius-panel,8px)] border ${
                              isMatched
                                ? 'bg-[var(--surface-raised)] border-l-4 border-l-[var(--critical)] border-[var(--hairline)]'
                                : 'bg-[var(--canvas)] border-[var(--hairline)] opacity-75'
                            } space-y-2`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-2">
                                {isMatched ? (
                                  <Check className="w-4 h-4 text-[var(--critical)] shrink-0 font-bold" />
                                ) : (
                                  <X className="w-4 h-4 text-[var(--muted)] shrink-0" />
                                )}
                                <span className="font-heading font-semibold text-xs text-[var(--ink)]">
                                  {evalItem.rule_name || evalItem.rule_id}
                                </span>
                              </div>

                              <span
                                className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                                  evalItem.decision === 'created'
                                    ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                                    : evalItem.decision === 'suppressed'
                                      ? 'bg-[var(--stale-bg)] text-[var(--stale)]'
                                      : 'bg-[var(--hairline)] text-[var(--muted)]'
                                }`}
                              >
                                {evalItem.decision === 'created'
                                  ? 'Triggered Incident'
                                  : evalItem.decision === 'suppressed'
                                    ? 'Deduplicated to Active'
                                    : 'No Match'}
                              </span>
                            </div>

                            {/* Checklist Breakdown */}
                            <div className="bg-[var(--surface)] p-2.5 rounded-[var(--radius-control,6px)] border border-[var(--hairline)] font-mono text-xs space-y-1">
                              <div className="flex items-start justify-between">
                                <span className="text-[var(--muted)]">Condition:</span>
                                <span className="text-[var(--ink)] font-semibold text-right max-w-xs">
                                  {evalItem.reason || 'Threshold check'}
                                </span>
                              </div>

                              {evalItem.decision_explanation && (
                                <div className="pt-1.5 border-t border-[var(--hairline)] flex items-start justify-between">
                                  <span className="text-[var(--muted)]">Decision:</span>
                                  <span className="text-[var(--ink)] font-semibold text-right max-w-xs">
                                    {evalItem.decision_explanation}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-6 text-center text-xs text-[var(--muted)] bg-[var(--surface-raised)] rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] font-mono">
                      No evaluation record found for this incident.
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Linked Telemetry Events */}
              {activeTab === 'events' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-heading font-semibold text-xs text-[var(--ink)]">
                      Attached Events ({data?.events?.length || 0})
                    </span>
                  </div>

                  <div className="space-y-2">
                    {data?.events.map((ev) => (
                      <div
                        key={ev.event_id}
                        className="p-3.5 bg-[var(--surface-raised)] rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] flex items-center justify-between font-mono text-xs"
                      >
                        <div className="space-y-1 min-w-0 pr-3">
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-[var(--ink)]">#{ev.seq}</span>
                            <span className="text-[var(--accent)] font-semibold">{ev.type}</span>
                            <span className="text-[10px] text-[var(--muted)] truncate max-w-xs">{ev.event_id}</span>
                          </div>
                          <div className="text-[10px] text-[var(--muted)]">
                            {new Date(ev.ts).toLocaleString()}
                          </div>
                          {ev.payload && (
                            <pre className="text-[10px] text-[var(--ink)] bg-[var(--surface)] p-2 rounded border border-[var(--hairline)] max-w-md truncate">
                              {JSON.stringify(ev.payload)}
                            </pre>
                          )}
                        </div>

                        <button
                          onClick={() => onExplainEvent(ev.event_id)}
                          className="px-2.5 py-1 rounded-[var(--radius-control,6px)] bg-[var(--surface)] hover:bg-[var(--canvas)] text-[var(--accent)] text-xs font-mono font-semibold border border-[var(--hairline)] transition shrink-0"
                        >
                          Explain
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tab 4: History Timeline */}
              {activeTab === 'timeline' && (
                <div className="space-y-4">
                  <h3 className="font-heading font-semibold text-xs text-[var(--ink)]">
                    Audit Timeline
                  </h3>
                  {data?.history && data.history.length > 0 ? (
                    <div className="relative pl-4 border-l border-[var(--hairline)] space-y-4 font-mono text-xs">
                      {data.history.map((hist) => (
                        <div key={hist.id} className="relative">
                          <span className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-[var(--accent)] ring-4 ring-[var(--surface)]" />
                          <div className="flex items-center space-x-2 text-xs">
                            <span className="text-[var(--muted)] capitalize">{hist.from_status || 'created'}</span>
                            <span className="text-[var(--muted)]">&rarr;</span>
                            <span className="font-bold text-[var(--ink)] capitalize">{hist.to_status}</span>
                          </div>
                          <div className="text-xs text-[var(--ink)] mt-1 font-sans">{hist.reason}</div>
                          <div className="text-[11px] text-[var(--muted)] mt-1 flex items-center space-x-2">
                            <span>Actor: {hist.actor}</span>
                            <span>·</span>
                            <span>
                              {new Date(hist.created_at || hist.timestamp || '').toLocaleString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[var(--muted)] text-xs font-mono">No state transitions recorded.</p>
                  )}
                </div>
              )}

              {/* Tab 5: Notification Deliveries */}
              {activeTab === 'notifications' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-heading font-semibold text-xs text-[var(--ink)]">
                        Operator Webhook Deliveries
                      </h3>
                      <p className="text-[11px] text-[var(--muted)] mt-0.5">
                        Delivered to assigned location operator with backoff retry.
                      </p>
                    </div>

                    <div className="flex items-center space-x-2">
                      <span
                        className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                          incident.notification_status === 'sent'
                            ? 'bg-[var(--healthy-bg)] text-[var(--healthy)]'
                            : incident.notification_status === 'dead'
                              ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                              : 'bg-[var(--stale-bg)] text-[var(--stale)]'
                        }`}
                      >
                        {incident.notification_status || 'pending'}
                      </span>

                      {incident.notification_status === 'dead' && (
                        <ActionButton
                          isOffline={isOffline}
                          variant="secondary"
                          disabled={retryingNotif}
                          onClick={handleRetryNotification}
                        >
                          <RefreshCw className="w-3 h-3 mr-1" />
                          {retryingNotif ? 'Retrying...' : 'Retry notification'}
                        </ActionButton>
                      )}
                    </div>
                  </div>

                  {data?.notifications && data.notifications.length > 0 ? (
                    <div className="space-y-2">
                      {data.notifications.map((n: any) => (
                        <div
                          key={n.id}
                          className="p-3.5 bg-[var(--surface-raised)] rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] space-y-1.5 font-mono text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-[var(--ink)] truncate max-w-xs">
                              {n.destination_url}
                            </span>
                            <span className="text-[10px] text-[var(--muted)]">
                              Attempts: {n.attempts}
                            </span>
                          </div>
                          {n.last_error && (
                            <div className="text-[11px] text-[var(--critical)] font-sans">
                              {n.last_error}
                            </div>
                          )}
                          <div className="text-[10px] text-[var(--muted)]">
                            {new Date(n.created_at).toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[var(--muted)] text-xs font-mono">No notifications recorded.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
