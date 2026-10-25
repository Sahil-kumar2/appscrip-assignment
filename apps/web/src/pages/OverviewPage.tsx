import React, { useState, useEffect, useMemo } from 'react';
import { usePlatformStore } from '../store/PlatformContext.js';
import { Sparkline } from '../components/Sparkline.js';
import { ActionButton } from '../components/ActionButton.js';
import { FleetHealthRing } from '../components/FleetHealthRing.js';
import { groupIncidents, GroupedIncident, formatRelativeTime } from '../utils/incidentGrouping.js';
import { useToast } from '../components/Toast.js';
import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Activity,
  Radio,
  Flame,
  Clock,
  Layers,
  MapPin,
  ArrowUpRight,
} from 'lucide-react';

interface OverviewPageProps {
  onNavigateTab: (tab: string) => void;
  onSelectIncident: (id: string) => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  onNavigateTab,
  onSelectIncident,
}) => {
  const { state, acknowledgeIncident, resolveIncident } = usePlatformStore();
  const { stats, incidents, devices, liveEvents, connection } = state;
  const isOffline = connection.status === 'offline';
  const { showToast } = useToast();

  const [selectedGroupIndex, setSelectedGroupIndex] = useState<number>(0);

  // Group all open/acknowledged incidents by rule+device
  const openIncidentsList = useMemo(() => {
    return Object.values(incidents).filter(
      (i) => i.status === 'open' || i.status === 'acknowledged'
    );
  }, [incidents]);

  const groupedIncidents = useMemo(() => {
    return groupIncidents(openIncidentsList);
  }, [openIncidentsList]);

  const devicesList = useMemo(() => Object.values(devices), [devices]);

  const onlineDevicesCount = useMemo(() => {
    return devicesList.filter((d) => d.status === 'online').length;
  }, [devicesList]);

  const staleDevicesCount = useMemo(() => {
    return devicesList.filter((d) => d.status === 'stale').length;
  }, [devicesList]);

  const offlineDevicesCount = useMemo(() => {
    return devicesList.filter((d) => d.status === 'offline').length;
  }, [devicesList]);

  const criticalCount = useMemo(() => {
    return groupedIncidents.filter((g) => g.severity === 'critical' && g.status === 'open').length;
  }, [groupedIncidents]);

  // Devices grouped by location_id
  const devicesByLocation = useMemo(() => {
    const map: Record<string, typeof devicesList> = {};
    devicesList.forEach((d) => {
      const loc = d.location_id || 'unassigned';
      if (!map[loc]) map[loc] = [];
      map[loc].push(d);
    });
    return map;
  }, [devicesList]);

  // Generate human-language status summary sentence
  const statusSentence = useMemo(() => {
    if (offlineDevicesCount > 0 && groupedIncidents.length > 0) {
      return `${offlineDevicesCount} ${offlineDevicesCount === 1 ? 'device is' : 'devices are'} offline and ${groupedIncidents.length} ${groupedIncidents.length === 1 ? 'incident needs' : 'incidents need'} attention`;
    }
    if (criticalCount > 0) {
      return `${criticalCount} critical ${criticalCount === 1 ? 'incident requires' : 'incidents require'} immediate triage`;
    }
    if (groupedIncidents.length > 0) {
      return `${groupedIncidents.length} ${groupedIncidents.length === 1 ? 'incident needs' : 'incidents need'} review`;
    }
    if (offlineDevicesCount > 0) {
      return `${offlineDevicesCount} ${offlineDevicesCount === 1 ? 'device is' : 'devices are'} offline`;
    }
    return 'All systems nominal · Zero anomalies detected';
  }, [offlineDevicesCount, groupedIncidents.length, criticalCount]);

  // Sparklines
  const rateSparkline = useMemo(() => {
    const rate = stats?.events_per_minute ?? 100;
    return [
      Math.max(10, rate * 0.85),
      Math.max(10, rate * 0.92),
      Math.max(10, rate * 0.8),
      Math.max(10, rate * 1.05),
      Math.max(10, rate * 0.98),
      rate,
    ];
  }, [stats?.events_per_minute]);

  const delaySparkline = useMemo(() => {
    const delay = stats?.queue_depth_and_lag?.lag_seconds ?? 0;
    return [delay + 1, delay, delay + 2, Math.max(0, delay - 1), delay];
  }, [stats?.queue_depth_and_lag?.lag_seconds]);

  // Quick Action Handlers with Toast Feedback
  const handleQuickAck = async (e: React.MouseEvent, group: GroupedIncident) => {
    e.stopPropagation();
    const success = await acknowledgeIncident(group.primaryId, 'operator:ui', 'Operator acknowledged');
    if (success) {
      showToast('Acknowledged', `${group.rule_name} on ${group.device_name}`);
    }
  };

  const handleQuickResolve = async (e: React.MouseEvent, group: GroupedIncident) => {
    e.stopPropagation();
    const success = await resolveIncident(group.primaryId, 'operator:ui', 'Operator resolved');
    if (success) {
      showToast('Resolved', `${group.rule_name} on ${group.device_name}`);
    }
  };

  // Keyboard Navigation: J/K, A, R, Enter
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        document.activeElement?.tagName === 'SELECT'
      ) {
        return;
      }

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setSelectedGroupIndex((prev) => Math.min(groupedIncidents.length - 1, prev + 1));
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setSelectedGroupIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'a' || e.key === 'A') {
        const cur = groupedIncidents[selectedGroupIndex];
        if (cur && cur.status === 'open' && !isOffline) {
          e.preventDefault();
          acknowledgeIncident(cur.primaryId, 'operator:keyboard', 'Keyboard shortcut A').then(
            (ok) => ok && showToast('Acknowledged', `${cur.rule_name} on ${cur.device_name}`)
          );
        }
      } else if (e.key === 'r' || e.key === 'R') {
        const cur = groupedIncidents[selectedGroupIndex];
        if (cur && !isOffline) {
          e.preventDefault();
          resolveIncident(cur.primaryId, 'operator:keyboard', 'Keyboard shortcut R').then(
            (ok) => ok && showToast('Resolved', `${cur.rule_name} on ${cur.device_name}`)
          );
        }
      } else if (e.key === 'Enter') {
        const cur = groupedIncidents[selectedGroupIndex];
        if (cur) {
          e.preventDefault();
          onSelectIncident(cur.primaryId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [groupedIncidents, selectedGroupIndex, isOffline, acknowledgeIncident, resolveIncident, onSelectIncident, showToast]);

  return (
    <div className="space-y-6">
      {/* 1. Situation Board Hero Header */}
      <section className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-5 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
              <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--muted)]">
                FLEET SITUATION BOARD
              </span>
            </div>

            <h1 className="text-xl sm:text-2xl font-heading font-bold tracking-tight text-[var(--ink)] flex items-center space-x-2.5">
              <span>{statusSentence}</span>
              {groupedIncidents.length === 0 && offlineDevicesCount === 0 && (
                <CheckCircle2 className="w-5 h-5 text-[var(--healthy)] shrink-0" />
              )}
            </h1>

            <p className="text-xs text-[var(--muted)]">
              Continuous PostgreSQL-backed telemetry ingestion · Real-time rule evaluation
            </p>
          </div>

          {/* Fleet Health Ring Widget */}
          <div className="bg-[var(--surface-raised)] rounded-[var(--radius-panel,8px)] border border-[var(--hairline)]">
            <FleetHealthRing
              total={devicesList.length}
              online={onlineDevicesCount}
              stale={staleDevicesCount}
              offline={offlineDevicesCount}
            />
          </div>
        </div>

        {/* 2. Row of 4 KPI Tiles with Mission Control Styling */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-5 mt-5 border-t border-[var(--hairline)]">
          {/* KPI 1: Ingestion Rate */}
          <div className="p-3 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-[11px] font-mono text-[var(--muted)] uppercase tracking-wider">
                Telemetry Rate
              </div>
              <div className="text-2xl font-bold font-mono tabular-nums text-[var(--ink)] leading-none">
                {stats?.events_per_minute ?? 0}
                <span className="text-xs font-normal text-[var(--muted)] ml-1">ev/m</span>
              </div>
            </div>
            <Sparkline data={rateSparkline} color="var(--accent)" width={60} height={20} />
          </div>

          {/* KPI 2: Active Incidents */}
          <div className="p-3 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-[11px] font-mono text-[var(--muted)] uppercase tracking-wider">
                Open Incidents
              </div>
              <div
                className={`text-2xl font-bold font-mono tabular-nums leading-none ${
                  criticalCount > 0
                    ? 'text-[var(--critical)]'
                    : groupedIncidents.length > 0
                      ? 'text-[var(--stale)]'
                      : 'text-[var(--healthy)]'
                }`}
              >
                {groupedIncidents.length}
                <span className="text-xs font-normal text-[var(--muted)] ml-1">
                  ({criticalCount} crit)
                </span>
              </div>
            </div>
            <ShieldAlert
              className={`w-5 h-5 ${
                criticalCount > 0
                  ? 'text-[var(--critical)] animate-pulse'
                  : groupedIncidents.length > 0
                    ? 'text-[var(--stale)]'
                    : 'text-[var(--healthy)]'
              }`}
            />
          </div>

          {/* KPI 3: Offline Devices */}
          <div className="p-3 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-[11px] font-mono text-[var(--muted)] uppercase tracking-wider">
                Offline Devices
              </div>
              <div
                className={`text-2xl font-bold font-mono tabular-nums leading-none ${
                  offlineDevicesCount > 0 ? 'text-[var(--critical)]' : 'text-[var(--healthy)]'
                }`}
              >
                {offlineDevicesCount}
                <span className="text-xs font-normal text-[var(--muted)] ml-1">
                  / {devicesList.length} total
                </span>
              </div>
            </div>
            <Cpu
              className={`w-5 h-5 ${
                offlineDevicesCount > 0 ? 'text-[var(--critical)] animate-pulse' : 'text-[var(--healthy)]'
              }`}
            />
          </div>

          {/* KPI 4: Queue Depth & Delay */}
          <div className="p-3 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="text-[11px] font-mono text-[var(--muted)] uppercase tracking-wider">
                Queue Depth / Lag
              </div>
              <div className="text-2xl font-bold font-mono tabular-nums text-[var(--ink)] leading-none">
                {stats?.queue_depth_and_lag?.depth ?? 0}
                <span className="text-xs font-normal text-[var(--muted)] ml-1">
                  ({stats?.queue_depth_and_lag?.lag_seconds ?? 0}s)
                </span>
              </div>
            </div>
            <Sparkline data={delaySparkline} color="var(--healthy)" width={60} height={20} />
          </div>
        </div>
      </section>

      {/* 3. Location-Grouped Device Grid: Compact Status Tiles */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <MapPin className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="font-heading font-semibold text-sm text-[var(--ink)] tracking-tight">
              Fleet Status by Location
            </h2>
            <span className="px-2 py-0.5 rounded-full text-xs font-mono font-medium bg-[var(--hairline)] text-[var(--muted)]">
              {devicesList.length} devices
            </span>
          </div>

          <button
            onClick={() => onNavigateTab('devices')}
            className="text-xs text-[var(--accent)] hover:underline font-medium inline-flex items-center space-x-1"
          >
            <span>All devices</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="space-y-4">
          {Object.entries(devicesByLocation).map(([locId, locDevices]) => (
            <div
              key={locId}
              className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-4 space-y-3 shadow-xs"
            >
              <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] pb-2">
                <div className="flex items-center space-x-2">
                  <span className="font-mono text-xs font-semibold text-[var(--ink)]">
                    {locId}
                  </span>
                  <span className="text-xs text-[var(--muted)]">
                    ({locDevices.length} {locDevices.length === 1 ? 'unit' : 'units'})
                  </span>
                </div>
                <div className="text-[11px] font-mono text-[var(--muted)]">
                  {locDevices.filter((d) => d.status === 'online').length} online
                </div>
              </div>

              {/* Status Tiles Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {locDevices.map((device) => {
                  const relativeTime = formatRelativeTime(device.last_seen_at);
                  const isOnline = device.status === 'online';
                  const isStale = device.status === 'stale';
                  const isOfflineDev = device.status === 'offline';
                  const mockActivity = [2, 4, 3, 5, 4, isOnline ? 6 : 1];

                  return (
                    <div
                      key={device.id}
                      onClick={() => onNavigateTab('events')}
                      className={`p-2.5 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] hover:border-[var(--accent)]/50 transition cursor-pointer space-y-2 select-none group ${
                        isOfflineDev
                          ? 'border-l-4 border-l-[var(--critical)]'
                          : isStale
                            ? 'border-l-4 border-l-[var(--stale)]'
                            : 'border-l-4 border-l-[var(--healthy)]'
                      }`}
                      title={`Click to view live events for ${device.name}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 pr-1">
                          <div className="font-heading font-semibold text-xs text-[var(--ink)] truncate group-hover:text-[var(--accent)] transition">
                            {device.name}
                          </div>
                          <div className="text-[10px] font-mono text-[var(--muted)] truncate">
                            {device.id}
                          </div>
                        </div>

                        {/* Pulsing Status Dot (pulse ONLY for stale/offline) */}
                        <span className="relative flex h-2 w-2 shrink-0 mt-1">
                          {(isStale || isOfflineDev) && (
                            <span
                              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                                isOfflineDev ? 'bg-[var(--critical)]' : 'bg-[var(--stale)]'
                              }`}
                            />
                          )}
                          <span
                            className={`relative inline-flex rounded-full h-2 w-2 ${
                              isOnline
                                ? 'bg-[var(--healthy)]'
                                : isStale
                                  ? 'bg-[var(--stale)]'
                                  : 'bg-[var(--critical)]'
                            }`}
                          />
                        </span>
                      </div>

                      {/* Sparkline & Last Seen Age */}
                      <div className="flex items-center justify-between pt-1 text-[10px] font-mono text-[var(--muted)]">
                        <Sparkline
                          data={mockActivity}
                          width={44}
                          height={14}
                          color={isOnline ? 'var(--healthy)' : 'var(--muted)'}
                        />
                        <span title={device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : ''}>
                          {device.last_seen_at ? relativeTime : 'Never'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Attention Queue & Live Feed Split */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): Grouped Incident Triage Queue */}
        <section className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <ShieldAlert className="w-4 h-4 text-[var(--critical)]" />
              <h2 className="font-heading font-semibold text-sm text-[var(--ink)] tracking-tight">
                Triage Queue
              </h2>
              <span className="px-2 py-0.5 rounded-full text-xs font-mono font-medium bg-[var(--hairline)] text-[var(--muted)]">
                {groupedIncidents.length}
              </span>
            </div>

            <div className="hidden sm:flex items-center space-x-3 text-xs text-[var(--muted)] font-mono">
              <span>J/K move</span>
              <span>·</span>
              <span>A acknowledge</span>
              <span>·</span>
              <span>R resolve</span>
            </div>
          </div>

          {groupedIncidents.length === 0 ? (
            <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-10 text-center space-y-2 shadow-xs">
              <CheckCircle2 className="w-7 h-7 text-[var(--healthy)] mx-auto" />
              <div className="text-sm font-heading font-semibold text-[var(--ink)]">
                No active incidents in triage.
              </div>
              <p className="text-xs text-[var(--muted)]">
                All rules are evaluating within safe thresholds. New incidents will stream here automatically.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {groupedIncidents.map((group, idx) => {
                const isSelected = idx === selectedGroupIndex;
                const isCritical = group.severity === 'critical';
                const isOpen = group.status === 'open';

                return (
                  <div
                    key={group.key}
                    onClick={() => onSelectIncident(group.primaryId)}
                    className={`bg-[var(--surface)] border-l-4 ${
                      isCritical ? 'border-l-[var(--critical)]' : 'border-l-[var(--stale)]'
                    } border border-[var(--hairline)] rounded-[var(--radius-control,6px)] p-3.5 cursor-pointer transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs ${
                      isSelected
                        ? 'ring-1 ring-[var(--accent)] border-[var(--accent)] bg-[var(--surface-raised)]'
                        : 'hover:border-[var(--muted)]/40 hover:bg-[var(--surface-raised)]'
                    }`}
                  >
                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        {isCritical ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-[var(--critical)] shrink-0" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-[var(--stale)] shrink-0" />
                        )}

                        <span
                          className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-bold uppercase tracking-wider ${
                            isCritical
                              ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                              : 'bg-[var(--stale-bg)] text-[var(--stale)]'
                          }`}
                        >
                          {group.severity}
                        </span>

                        <span
                          className={`px-1.5 py-0.2 rounded font-mono text-[10px] font-semibold capitalize ${
                            isOpen
                              ? 'bg-[var(--surface-raised)] text-[var(--ink)] border border-[var(--hairline)]'
                              : 'bg-[var(--acknowledged-bg)] text-[var(--acknowledged)]'
                          }`}
                        >
                          {group.status}
                        </span>

                        <span className="font-heading font-semibold text-xs text-[var(--ink)] truncate">
                          {group.rule_name}
                        </span>
                      </div>

                      {group.summary && (
                        <p className="text-xs text-[var(--ink)]/90 truncate max-w-xl">
                          {group.summary}
                        </p>
                      )}

                      <div className="flex items-center space-x-3 text-xs text-[var(--muted)]">
                        <span className="font-mono text-xs text-[var(--ink)] font-medium">
                          {group.device_name}
                        </span>
                        <span>·</span>
                        <span className="inline-flex items-center space-x-1 text-xs font-mono">
                          <Flame className="w-3 h-3 text-[var(--stale)]" />
                          <span>{group.occurrence_count} occurrences</span>
                        </span>
                        <span>·</span>
                        <span
                          className="font-mono text-[11px]"
                          title={group.last_event_at ? new Date(group.last_event_at).toLocaleString() : ''}
                        >
                          {group.age}
                        </span>
                      </div>
                    </div>

                    <div
                      className="flex items-center space-x-2 shrink-0 sm:self-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isOpen && (
                        <ActionButton
                          variant="warning"
                          isOffline={isOffline}
                          className="text-xs py-1"
                          onClick={(e) => handleQuickAck(e, group)}
                        >
                          Acknowledge
                        </ActionButton>
                      )}

                      <ActionButton
                        variant="secondary"
                        isOffline={isOffline}
                        className="text-xs py-1"
                        onClick={(e) => handleQuickResolve(e, group)}
                      >
                        Resolve
                      </ActionButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Right Column (1 Col): Live Telemetry Feed */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Radio className="w-4 h-4 text-[var(--accent)] animate-pulse" />
              <h2 className="font-heading font-semibold text-sm text-[var(--ink)] tracking-tight">
                Live Feed
              </h2>
            </div>
            <button
              onClick={() => onNavigateTab('events')}
              className="text-xs text-[var(--accent)] hover:underline font-medium"
            >
              All events &rarr;
            </button>
          </div>

          <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs divide-y divide-[var(--hairline)]">
            {liveEvents.length === 0 ? (
              <div className="p-8 text-center text-xs text-[var(--muted)]">
                Awaiting incoming device activity...
              </div>
            ) : (
              liveEvents.slice(0, 7).map((ev) => (
                <div
                  key={`${ev.id}-${ev.seq}`}
                  className="p-3 text-xs flex items-center justify-between hover:bg-[var(--surface-raised)] transition font-mono"
                >
                  <div className="space-y-0.5 truncate pr-2">
                    <div className="text-[var(--ink)] font-sans font-medium truncate">
                      {ev.device_id}
                    </div>
                    <div className="text-[11px] text-[var(--muted)]">
                      {ev.type}
                    </div>
                  </div>
                  <div className="text-right shrink-0 text-[11px] text-[var(--muted)]">
                    {ev.ts
                      ? new Date(ev.ts).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })
                      : 'now'}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
