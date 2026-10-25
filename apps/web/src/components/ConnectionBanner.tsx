import React from 'react';
import { ConnectionState } from '../types.js';
import { AlertTriangle, WifiOff, RefreshCw, Clock } from 'lucide-react';

interface ConnectionBannerProps {
  connection: ConnectionState;
  onManualReconnect?: () => void;
}

export const ConnectionBanner: React.FC<ConnectionBannerProps> = ({
  connection,
  onManualReconnect,
}) => {
  const { status, offlineSince, isStale, lastSeq } = connection;

  const formatOfflineTime = (date: Date | null): string => {
    if (!date) return '';
    const d = new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Connected state: calm & hidden visually, present for semantic test assertions
  if (status === 'connected') {
    return (
      <div
        data-testid="connection-banner-connected"
        className="hidden"
        aria-live="polite"
      >
        <span>Connected to real-time event stream</span>
        <span>Sequence #{lastSeq}</span>
      </div>
    );
  }

  const timeStr = formatOfflineTime(offlineSince);

  if (status === 'reconnecting') {
    return (
      <div
        data-testid="connection-banner-reconnecting"
        role="alert"
        className="w-full bg-[var(--stale-bg)] border-b border-[var(--stale)]/30 px-4 py-2 text-xs text-[var(--ink)] flex items-center justify-between shadow-sm"
      >
        <div className="flex items-center space-x-2.5">
          <AlertTriangle className="w-4 h-4 text-[var(--stale)] shrink-0 animate-pulse" />
          <span className="font-semibold text-[var(--stale)] font-heading">Reconnecting...</span>
          <span className="text-[var(--muted)]">
            Stream interrupted. {timeStr ? `Showing cached snapshot from ${timeStr}` : 'Showing cached data'}.
          </span>
        </div>

        {isStale && (
          <span className="px-2 py-0.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] text-[var(--stale)] border border-[var(--stale)]/40 font-mono font-medium text-[11px] tracking-wider uppercase">
            STALE DATA
          </span>
        )}
      </div>
    );
  }

  // Offline status
  return (
    <div
      data-testid="connection-banner-offline"
      role="alert"
      className="w-full bg-[var(--critical-bg)] border-b border-[var(--critical)]/30 px-4 py-2.5 text-xs text-[var(--ink)] flex flex-wrap items-center justify-between gap-3 shadow-sm"
    >
      <div className="flex items-center space-x-2.5">
        <WifiOff className="w-4 h-4 text-[var(--critical)] shrink-0 animate-pulse" />
        <span className="font-semibold text-[var(--critical)] font-heading">
          Offline since {timeStr || 'hh:mm:ss'}
        </span>
        <span className="text-[var(--muted)]">
          · Showing cached data (stale) · Action buttons disabled
        </span>
      </div>

      <div className="flex items-center space-x-2">
        <span className="px-2 py-0.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] text-[var(--critical)] border border-[var(--critical)]/40 font-mono font-medium text-[11px] uppercase tracking-wider">
          OFFLINE
        </span>
        {onManualReconnect && (
          <button
            onClick={onManualReconnect}
            className="px-2.5 py-1 rounded-[var(--radius-control,6px)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-[var(--ink)] border border-[var(--hairline)] font-medium text-xs flex items-center space-x-1.5 transition active:scale-95"
          >
            <RefreshCw className="w-3 h-3 text-[var(--accent)]" />
            <span>Retry Now</span>
          </button>
        )}
      </div>
    </div>
  );
};
