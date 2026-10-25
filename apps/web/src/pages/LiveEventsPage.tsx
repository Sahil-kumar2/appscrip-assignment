import React, { useState, useEffect, useRef, useMemo } from 'react';
import { usePlatformStore } from '../store/PlatformContext.js';
import { LiveEventItem } from '../types.js';
import {
  Play,
  Pause,
  HelpCircle,
  Filter,
  X,
  Radio,
  Clock,
  RotateCcw,
  Sparkles,
  WifiOff,
} from 'lucide-react';

interface LiveEventsPageProps {
  initialDeviceFilter?: string | null;
  onClearInitialDeviceFilter?: () => void;
  onExplainEvent: (eventId: string) => void;
}

export const LiveEventsPage: React.FC<LiveEventsPageProps> = ({
  initialDeviceFilter = null,
  onClearInitialDeviceFilter,
  onExplainEvent,
}) => {
  const { state } = usePlatformStore();
  const { liveEvents, devices, connection } = state;
  const isOffline = connection.status === 'offline';

  const [deviceFilter, setDeviceFilter] = useState<string>(initialDeviceFilter || 'all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  // When paused, freeze the events view
  const [frozenEvents, setFrozenEvents] = useState<LiveEventItem[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Track latest event ID to trigger brief flash
  const prevLatestIdRef = useRef<string | null>(null);
  const [latestFlashedId, setLatestFlashedId] = useState<string | null>(null);

  // Sync initial filter prop if changed
  useEffect(() => {
    if (initialDeviceFilter) {
      setDeviceFilter(initialDeviceFilter);
    }
  }, [initialDeviceFilter]);

  // Handle Pause/Resume
  const handleTogglePause = () => {
    if (!isPaused) {
      setFrozenEvents([...liveEvents]);
      setIsPaused(true);
    } else {
      setIsPaused(false);
    }
  };

  const activeEvents = isPaused ? frozenEvents : liveEvents;

  // Flash newest event
  useEffect(() => {
    if (liveEvents.length > 0 && !isPaused) {
      const newest = liveEvents[0];
      const id = `${newest.id}-${newest.seq}`;
      if (prevLatestIdRef.current && prevLatestIdRef.current !== id) {
        setLatestFlashedId(id);
        const timer = setTimeout(() => setLatestFlashedId(null), 1200);
        return () => clearTimeout(timer);
      }
      prevLatestIdRef.current = id;
    }
  }, [liveEvents, isPaused]);

  // Filter events and cap at 100 rows for high performance
  const filteredEvents = useMemo(() => {
    return activeEvents
      .filter((ev) => {
        const matchDevice = deviceFilter === 'all' || ev.device_id === deviceFilter;
        const matchType = typeFilter === 'all' || ev.type === typeFilter;
        return matchDevice && matchType;
      })
      .slice(0, 100);
  }, [activeEvents, deviceFilter, typeFilter]);

  // Auto-scroll effect: scroll to top when new events arrive if autoScroll is enabled
  useEffect(() => {
    if (autoScroll && containerRef.current && !isPaused) {
      containerRef.current.scrollTop = 0;
    }
  }, [liveEvents, autoScroll, isPaused]);

  // Extract unique types from current stream
  const eventTypes = useMemo(() => {
    const types = new Set<string>();
    liveEvents.forEach((e) => {
      if (e.type) types.add(e.type);
    });
    return Array.from(types);
  }, [liveEvents]);

  const activeFilterChips = useMemo(() => {
    const chips: Array<{ id: string; label: string; onRemove: () => void }> = [];
    if (deviceFilter !== 'all') {
      const devName = devices[deviceFilter]?.name || deviceFilter;
      chips.push({
        id: 'device',
        label: `Device: ${devName}`,
        onRemove: () => {
          setDeviceFilter('all');
          if (onClearInitialDeviceFilter) onClearInitialDeviceFilter();
        },
      });
    }
    if (typeFilter !== 'all') {
      chips.push({
        id: 'type',
        label: `Type: ${typeFilter}`,
        onRemove: () => setTypeFilter('all'),
      });
    }
    return chips;
  }, [deviceFilter, typeFilter, devices, onClearInitialDeviceFilter]);

  return (
    <div className={`space-y-4 ${isOffline ? 'opacity-90' : ''}`}>
      {/* Header & Controls Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center space-x-2">
            <Radio className="w-4 h-4 text-[var(--accent)] animate-pulse" />
            <h1 className="text-xl sm:text-2xl font-heading font-bold tracking-tight text-[var(--ink)]">
              Live Telemetry Stream
            </h1>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Streaming events via Server-Sent Events (SSE) with millisecond timestamps and deduplication proof
          </p>
        </div>

        <div className="flex items-center space-x-2">
          {/* Pause / Resume Button */}
          <button
            onClick={handleTogglePause}
            className={`px-3 py-1.5 rounded-[var(--radius-control,6px)] text-xs font-mono font-medium border transition inline-flex items-center space-x-1.5 ${
              isPaused
                ? 'bg-[var(--stale-bg)] text-[var(--stale)] border-[var(--stale)]/30'
                : 'bg-[var(--surface)] text-[var(--ink)] border-[var(--hairline)] hover:bg-[var(--surface-raised)]'
            }`}
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isPaused ? 'RESUME STREAM' : 'PAUSE STREAM'}</span>
          </button>

          {/* Auto Scroll Toggle */}
          <label className="flex items-center space-x-2 text-xs font-mono text-[var(--ink)] cursor-pointer select-none bg-[var(--surface)] px-3 py-1.5 rounded-[var(--radius-control,6px)] border border-[var(--hairline)]">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded-[3px] border-[var(--hairline)] text-[var(--accent)] focus:ring-0"
            />
            <span>AUTO-SCROLL</span>
          </label>
        </div>
      </div>

      {/* Filter Chips Bar */}
      <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* Device Dropdown */}
          <div className="flex items-center space-x-1.5 text-[var(--muted)]">
            <span className="font-mono text-[11px] uppercase">Device:</span>
            <select
              value={deviceFilter}
              onChange={(e) => setDeviceFilter(e.target.value)}
              className="bg-[var(--canvas)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] px-2 py-1 text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono"
            >
              <option value="all">All devices</option>
              {Object.keys(devices).map((dId) => (
                <option key={dId} value={dId}>
                  {devices[dId].name || dId}
                </option>
              ))}
            </select>
          </div>

          {/* Type Dropdown */}
          <div className="flex items-center space-x-1.5 text-[var(--muted)]">
            <span className="font-mono text-[11px] uppercase">Type:</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-[var(--canvas)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] px-2 py-1 text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono"
            >
              <option value="all">All types</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Active Chips */}
          {activeFilterChips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded-[var(--radius-control,6px)] bg-[var(--accent-soft)] text-[var(--accent)] font-medium text-xs border border-[var(--accent)]/30 font-mono"
            >
              <span>{chip.label}</span>
              <button onClick={chip.onRemove} className="hover:opacity-75">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>

        <div className="text-[var(--muted)] text-xs font-mono">
          Showing <span className="font-bold text-[var(--ink)]">{filteredEvents.length}</span> (capped at 100)
        </div>
      </div>

      {/* Dense Live Events Table with Sticky Header */}
      <div
        ref={containerRef}
        className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-y-auto max-h-[72vh] shadow-xs relative"
      >
        {isOffline && (
          <div className="sticky top-0 z-20 bg-[var(--critical-bg)] text-[var(--critical)] border-b border-[var(--critical)]/30 px-4 py-1.5 text-xs font-mono flex items-center justify-between">
            <span className="flex items-center space-x-2">
              <WifiOff className="w-3.5 h-3.5" />
              <span>Offline — live updates paused. Showing cached snapshot.</span>
            </span>
            <span>Last Seq #{connection.lastSeq}</span>
          </div>
        )}

        <table className="w-full text-left text-xs">
          <thead className="bg-[var(--surface-raised)] border-b border-[var(--hairline)] text-[var(--muted)] text-[11px] font-mono sticky top-0 z-10 backdrop-blur-xs">
            <tr>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider">Seq</th>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider">Timestamp</th>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider">Device</th>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider">Type</th>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider">Payload</th>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider">Status</th>
              <th className="px-4 py-2.5 font-bold uppercase tracking-wider text-right">Inspect</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--hairline)]">
            {filteredEvents.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-[var(--muted)]">
                  <div className="flex flex-col items-center space-y-2">
                    <Radio className="w-6 h-6 text-[var(--muted)] animate-pulse" />
                    <span className="font-mono text-xs">Waiting for incoming telemetry stream...</span>
                  </div>
                </td>
              </tr>
            ) : (
              filteredEvents.map((ev) => {
                const rowKey = `${ev.id}-${ev.seq}`;
                const isFlash = latestFlashedId === rowKey;
                const formattedTime = ev.ts
                  ? new Date(ev.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      fractionalSecondDigits: 3,
                    })
                  : 'now';

                return (
                  <tr
                    key={rowKey}
                    className={`transition-colors font-mono hover:bg-[var(--surface-raised)] ${
                      isFlash ? 'animate-event-flash bg-[var(--accent-soft)]' : ''
                    }`}
                  >
                    <td className="px-4 py-2 text-[var(--ink)] font-bold">#{ev.seq}</td>

                    <td className="px-4 py-2 text-[var(--muted)] whitespace-nowrap">
                      {formattedTime}
                    </td>

                    <td className="px-4 py-2">
                      <span className="text-[var(--ink)] font-sans font-semibold">{ev.device_id}</span>
                    </td>

                    <td className="px-4 py-2">
                      <span className="px-1.5 py-0.5 rounded-[var(--radius-control,6px)] text-[11px] font-sans font-medium bg-[var(--surface-raised)] text-[var(--accent)] border border-[var(--hairline)]">
                        {ev.type}
                      </span>
                    </td>

                    <td className="px-4 py-2 max-w-xs md:max-w-md truncate text-[var(--muted)] text-[11px]">
                      {typeof ev.payload === 'object' && ev.payload !== null
                        ? JSON.stringify(ev.payload)
                        : String(ev.payload || '')}
                    </td>

                    <td className="px-4 py-2 whitespace-nowrap space-x-1.5">
                      {ev.is_duplicate ? (
                        <span className="px-1.5 py-0.5 rounded-[var(--radius-control,6px)] text-[10px] font-mono font-bold bg-[var(--stale-bg)] text-[var(--stale)] border border-[var(--stale)]/20 uppercase">
                          Duplicate
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded-[var(--radius-control,6px)] text-[10px] font-mono font-medium bg-[var(--healthy-bg)] text-[var(--healthy)] border border-[var(--healthy)]/20 uppercase">
                          Accepted
                        </span>
                      )}
                      {ev.is_late && (
                        <span className="px-1.5 py-0.5 rounded-[var(--radius-control,6px)] text-[10px] font-mono font-medium bg-[var(--hairline)] text-[var(--muted)] uppercase">
                          Late
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => onExplainEvent(ev.event_id || ev.id)}
                        className="text-[var(--muted)] hover:text-[var(--ink)] px-2 py-1 rounded-[var(--radius-control,6px)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] border border-[var(--hairline)] text-xs font-mono font-medium transition inline-flex items-center space-x-1"
                        title="Explain rule evaluations for this event"
                      >
                        <HelpCircle className="w-3.5 h-3.5 text-[var(--accent)]" />
                        <span>Explain</span>
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
  );
};
