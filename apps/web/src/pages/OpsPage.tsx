import React, { useState, useEffect } from 'react';
import { usePlatformStore } from '../store/PlatformContext.js';
import { authFetch } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { useToast } from '../components/Toast.js';
import {
  RefreshCw,
  RotateCcw,
  Terminal,
  Send,
  AlertTriangle,
  Clock,
  Layers,
  ChevronDown,
  ChevronRight,
  Server,
  Activity,
  CheckCircle2,
} from 'lucide-react';

export const OpsPage: React.FC = () => {
  const { state, requeueDeadLetter, retryDeadNotifications } = usePlatformStore();
  const { stats, connection } = state;
  const isOffline = connection.status === 'offline';
  const { showToast } = useToast();

  const [loading, setLoading] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(true);
  const [deadLetters, setDeadLetters] = useState<{
    failed_events: any[];
    dead_notifications: any[];
    rejected_events: any[];
  }>({
    failed_events: [],
    dead_notifications: [],
    rejected_events: [],
  });

  const [outboxItems, setOutboxItems] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'failed-events' | 'notifications'>('failed-events');
  const [requeuing, setRequeuing] = useState(false);

  const fetchOpsData = async () => {
    setLoading(true);
    try {
      const [dlRes, outboxRes] = await Promise.all([
        authFetch('/api/dead-letters')
          .then((r) => r.json())
          .catch(() => ({})),
        authFetch('/sink/notifications')
          .then((r) => r.json())
          .catch(() => []),
      ]);

      if (dlRes) {
        setDeadLetters({
          failed_events: dlRes.failed_events || [],
          dead_notifications: dlRes.dead_notifications || [],
          rejected_events: dlRes.rejected_events || [],
        });
      }

      if (Array.isArray(outboxRes)) {
        setOutboxItems(outboxRes);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOpsData();
    const interval = setInterval(fetchOpsData, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleRequeueAll = async () => {
    if (isOffline) return;
    setRequeuing(true);
    try {
      const success = await requeueDeadLetter({ target: 'all' });
      if (success) {
        showToast('Requeued', 'All failed events returned to processing queue');
        fetchOpsData();
      }
    } finally {
      setRequeuing(false);
    }
  };

  const handleRequeueSingleEvent = async (eventId: string) => {
    if (isOffline) return;
    try {
      const res = await authFetch(`/api/events/${eventId}/requeue`, { method: 'POST' });
      if (res.ok) {
        showToast('Requeued', `Event #${eventId} returned to queue`);
        fetchOpsData();
      }
    } catch (err: any) {
      showToast('Requeue failed', err.message, 'error');
    }
  };

  const handleRetryAllOutbox = async () => {
    if (isOffline) return;
    setRequeuing(true);
    try {
      const success = await retryDeadNotifications();
      if (success) {
        showToast('Retried', 'All dead notifications queued for delivery');
        fetchOpsData();
      }
    } finally {
      setRequeuing(false);
    }
  };

  const totalFailed =
    deadLetters.failed_events.length +
    deadLetters.dead_notifications.length +
    deadLetters.rejected_events.length;

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <Terminal className="w-4 h-4 text-[var(--accent)]" />
            <h1 className="text-xl sm:text-2xl font-heading font-bold tracking-tight text-[var(--ink)]">
              System Health &amp; Diagnostics
            </h1>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            PostgreSQL durable queue processing, dead-letter recovery, and outbox webhooks
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={fetchOpsData}
            disabled={loading}
            className="px-2.5 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--hairline)] transition text-xs font-mono flex items-center space-x-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>REFRESH</span>
          </button>

          <ActionButton
            isOffline={isOffline}
            variant="warning"
            disabled={requeuing || totalFailed === 0}
            onClick={handleRequeueAll}
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            <span>{requeuing ? 'Requeuing...' : 'Requeue All Dead Letters'}</span>
          </ActionButton>
        </div>
      </div>

      {/* Operator Status Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-[var(--surface)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] space-y-1 shadow-xs">
          <div className="text-[11px] font-mono uppercase text-[var(--muted)]">Queue Depth</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-[var(--ink)]">
            {stats?.queue_depth_and_lag.depth ?? 0}
          </div>
        </div>

        <div className="bg-[var(--surface)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] space-y-1 shadow-xs">
          <div className="text-[11px] font-mono uppercase text-[var(--muted)]">Processing Delay</div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums ${
              (stats?.queue_depth_and_lag.lag_seconds ?? 0) > 30
                ? 'text-[var(--critical)]'
                : 'text-[var(--healthy)]'
            }`}
          >
            {stats?.queue_depth_and_lag.lag_seconds ?? 0}
            <span className="text-xs font-normal text-[var(--muted)] ml-1">seconds</span>
          </div>
        </div>

        <div className="bg-[var(--surface)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] space-y-1 shadow-xs">
          <div className="text-[11px] font-mono uppercase text-[var(--muted)]">Dead Letters</div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums ${
              totalFailed > 0 ? 'text-[var(--critical)]' : 'text-[var(--ink)]'
            }`}
          >
            {totalFailed}
          </div>
        </div>

        <div className="bg-[var(--surface)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] space-y-1 shadow-xs">
          <div className="text-[11px] font-mono uppercase text-[var(--muted)]">Delivered Webhooks</div>
          <div className="text-2xl font-bold font-mono tabular-nums text-[var(--healthy)]">
            {stats?.outbox_state.sent ?? 0}
          </div>
        </div>
      </div>

      {/* Collapsible Technical Details Section */}
      <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs">
        <button
          onClick={() => setShowTechnicalDetails((prev) => !prev)}
          className="w-full px-5 py-3.5 flex items-center justify-between text-xs font-heading font-semibold text-[var(--ink)] hover:bg-[var(--surface-raised)] transition"
        >
          <div className="flex items-center space-x-2">
            <Server className="w-4 h-4 text-[var(--accent)]" />
            <span>PostgreSQL Queue Invariants &amp; Circuit Breaker</span>
          </div>
          {showTechnicalDetails ? (
            <ChevronDown className="w-4 h-4 text-[var(--muted)]" />
          ) : (
            <ChevronRight className="w-4 h-4 text-[var(--muted)]" />
          )}
        </button>

        {showTechnicalDetails && (
          <div className="px-5 pb-5 pt-2 border-t border-[var(--hairline)] space-y-3 font-mono text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)]">
                <span className="text-[10px] text-[var(--muted)] uppercase block">IN-FLIGHT LEASES</span>
                <span className="font-bold text-[var(--ink)] text-sm">
                  {stats?.queue_depth_and_lag.processing ?? 0}
                </span>
              </div>
              <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)]">
                <span className="text-[10px] text-[var(--muted)] uppercase block">COMMITTED DONE</span>
                <span className="font-bold text-[var(--healthy)] text-sm">
                  {stats?.queue_depth_and_lag.done ?? 0}
                </span>
              </div>
              <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)]">
                <span className="text-[10px] text-[var(--muted)] uppercase block">CIRCUIT BREAKER</span>
                <span className="font-bold text-[var(--healthy)] text-sm">CLOSED (NOMINAL)</span>
              </div>
              <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)]">
                <span className="text-[10px] text-[var(--muted)] uppercase block">MALFORMED REJECTIONS</span>
                <span className="font-bold text-[var(--ink)] text-sm">
                  {deadLetters.rejected_events.length}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tabs: Failed Events vs Notifications */}
      <div className="space-y-4">
        <div className="flex items-center space-x-1 border-b border-[var(--hairline)] pb-1">
          <button
            onClick={() => setActiveTab('failed-events')}
            className={`px-3 py-1.5 rounded-[var(--radius-control,6px)] text-xs font-mono font-medium transition ${
              activeTab === 'failed-events'
                ? 'bg-[var(--surface-raised)] text-[var(--accent)] font-bold border border-[var(--hairline)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Failed Events ({deadLetters.failed_events.length})
          </button>

          <button
            onClick={() => setActiveTab('notifications')}
            className={`px-3 py-1.5 rounded-[var(--radius-control,6px)] text-xs font-mono font-medium transition ${
              activeTab === 'notifications'
                ? 'bg-[var(--surface-raised)] text-[var(--accent)] font-bold border border-[var(--hairline)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Delivered Webhooks ({outboxItems.length})
          </button>
        </div>

        {/* Failed Events View */}
        {activeTab === 'failed-events' && (
          <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-[var(--surface-raised)] text-[var(--muted)] text-[11px] font-mono border-b border-[var(--hairline)]">
                  <tr>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Event ID</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Device</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Attempts</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Last Error</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline)]">
                  {deadLetters.failed_events.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-[var(--muted)] font-mono">
                        No failed dead-letter events in queue.
                      </td>
                    </tr>
                  ) : (
                    deadLetters.failed_events.map((ev) => (
                      <tr key={ev.event_id || ev.id} className="hover:bg-[var(--surface-raised)] transition">
                        <td className="px-4 py-2.5 font-medium text-[var(--ink)] select-all">
                          {ev.event_id || ev.id}
                        </td>
                        <td className="px-4 py-2.5 text-[var(--ink)]">{ev.device_id}</td>
                        <td className="px-4 py-2.5">
                          <span className="px-1.5 py-0.5 rounded font-mono font-bold text-[10px] bg-[var(--critical-bg)] text-[var(--critical)] uppercase">
                            {ev.attempts} attempts
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-[var(--critical)] max-w-xs truncate font-mono text-xs">
                          {ev.last_error || 'Execution failed'}
                        </td>
                        <td className="px-4 py-2.5 text-right font-sans">
                          <ActionButton
                            isOffline={isOffline}
                            variant="secondary"
                            onClick={() => handleRequeueSingleEvent(ev.event_id || ev.id)}
                          >
                            Requeue
                          </ActionButton>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Notifications View */}
        {activeTab === 'notifications' && (
          <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-heading font-bold text-sm text-[var(--ink)]">Notification Deliveries</h3>
                <p className="text-xs text-[var(--muted)]">
                  Audit log of operator webhook dispatches with idempotency signatures
                </p>
              </div>

              <ActionButton isOffline={isOffline} variant="warning" onClick={handleRetryAllOutbox}>
                Retry All Failed
              </ActionButton>
            </div>

            <div className="overflow-x-auto border border-[var(--hairline)] rounded-[var(--radius-control,6px)]">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-[var(--surface-raised)] text-[var(--muted)] text-[11px] font-mono border-b border-[var(--hairline)]">
                  <tr>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Delivery Key</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Incident</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Status</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Received</th>
                    <th className="px-4 py-2.5 uppercase tracking-wider font-bold">Payload</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline)]">
                  {outboxItems.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-[var(--muted)] font-mono">
                        No notifications delivered yet.
                      </td>
                    </tr>
                  ) : (
                    outboxItems.map((item, idx) => (
                      <tr key={item.id || idx} className="hover:bg-[var(--surface-raised)] transition">
                        <td className="px-4 py-2.5 text-[var(--ink)] select-all">
                          {item.idempotency_key || item.id}
                        </td>
                        <td className="px-4 py-2.5 text-[var(--muted)]">
                          {item.body?.incident_id || 'N/A'}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="px-2 py-0.5 rounded font-mono font-bold text-[10px] uppercase bg-[var(--healthy-bg)] text-[var(--healthy)]">
                            Delivered
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-[var(--muted)] whitespace-nowrap">
                          {new Date(item.received_at).toLocaleTimeString()}
                        </td>
                        <td className="px-4 py-2.5 text-[var(--muted)] max-w-sm truncate text-[11px]">
                          {typeof item.body === 'object'
                            ? JSON.stringify(item.body)
                            : String(item.body)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
