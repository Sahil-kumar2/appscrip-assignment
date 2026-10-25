import React, { useEffect, useState } from 'react';
import { ExplainData } from '../types.js';
import { authFetch } from '../api.js';
import { HelpCircle, X, Check, AlertTriangle, ShieldAlert, Cpu } from 'lucide-react';

interface ExplainModalProps {
  eventId: string | null;
  onClose: () => void;
}

export const ExplainModal: React.FC<ExplainModalProps> = ({ eventId, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ExplainData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    setLoading(true);
    setError(null);

    authFetch(`/api/events/${eventId}/explain`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error((await res.json()).error || 'Failed to fetch evaluation details');
        }
        return res.json();
      })
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [eventId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!eventId) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--hairline)] bg-[var(--surface-raised)]">
          <div className="space-y-0.5">
            <h3 className="font-heading font-bold text-sm text-[var(--ink)]">
              Event Evaluation Inspector
            </h3>
            <p className="text-xs text-[var(--muted)] font-mono">Event #{eventId}</p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--muted)] hover:text-[var(--ink)] p-1.5 rounded-[var(--radius-control,6px)] hover:bg-[var(--canvas)] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 text-xs">
          {loading ? (
            <div className="text-center py-12 text-[var(--muted)] font-mono">
              Evaluating rule decision graph...
            </div>
          ) : error ? (
            <div className="text-center py-12 text-[var(--critical)] bg-[var(--critical-bg)] rounded-[var(--radius-control,6px)] border border-[var(--critical)]/30 font-mono">
              {error}
            </div>
          ) : !data ? null : (
            <>
              {/* Event Metadata */}
              <div className="space-y-2">
                <h4 className="font-heading font-semibold text-xs text-[var(--ink)]">
                  Event Telemetry Context
                </h4>
                <div className="bg-[var(--surface-raised)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] font-mono text-xs space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[var(--muted)]">
                    <div>
                      <span className="block text-[10px] uppercase">Device:</span>
                      <span className="text-[var(--ink)] font-sans font-semibold">{data.event.device_id}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase">Sequence:</span>
                      <span className="text-[var(--ink)] font-bold">#{data.event.seq}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase">Type:</span>
                      <span className="text-[var(--accent)] font-sans">{data.event.type}</span>
                    </div>
                    <div>
                      <span className="block text-[10px] uppercase">Status:</span>
                      <span className="text-[var(--healthy)] font-sans font-bold uppercase">
                        {data.event.processing_status}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-[var(--hairline)]">
                    <span className="block text-[10px] text-[var(--muted)] uppercase mb-1">Payload:</span>
                    <pre className="bg-[var(--surface)] p-2.5 rounded-[var(--radius-control,6px)] text-[11px] text-[var(--ink)] overflow-x-auto border border-[var(--hairline)]">
                      {JSON.stringify(data.event.payload, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>

              {/* Rule Evaluations: Readable Checklist */}
              <div className="space-y-2">
                <h4 className="font-heading font-semibold text-xs text-[var(--ink)]">
                  Evaluated Rules ({data.evaluations.length})
                </h4>
                {data.evaluations.length === 0 ? (
                  <p className="text-xs text-[var(--muted)] bg-[var(--surface-raised)] p-4 rounded-[var(--radius-panel,8px)] border border-[var(--hairline)] font-mono">
                    No evaluations recorded for this event.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {data.evaluations.map((evalItem) => {
                      const isMatched = evalItem.matched || evalItem.decision === 'created' || evalItem.decision === 'suppressed';
                      return (
                        <div
                          key={evalItem.id}
                          className={`p-3.5 rounded-[var(--radius-panel,8px)] border ${
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
                                  ? 'Deduplicated'
                                  : 'No Match'}
                            </span>
                          </div>

                          <div className="bg-[var(--surface)] p-2 rounded-[var(--radius-control,6px)] border border-[var(--hairline)] font-mono text-xs space-y-1">
                            <div className="flex items-start justify-between">
                              <span className="text-[var(--muted)]">Condition:</span>
                              <span className="text-[var(--ink)] text-right font-medium max-w-sm">
                                {evalItem.reason}
                              </span>
                            </div>

                            {evalItem.decision_explanation &&
                              evalItem.decision_explanation !== evalItem.reason && (
                                <div className="pt-1 border-t border-[var(--hairline)] flex items-start justify-between">
                                  <span className="text-[var(--muted)]">Decision:</span>
                                  <span className="text-[var(--ink)] text-right font-medium max-w-sm">
                                    {evalItem.decision_explanation}
                                  </span>
                                </div>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[var(--hairline)] bg-[var(--surface-raised)] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--surface)] hover:bg-[var(--canvas)] text-[var(--ink)] text-xs font-mono font-medium rounded-[var(--radius-control,6px)] border border-[var(--hairline)] transition"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
};
