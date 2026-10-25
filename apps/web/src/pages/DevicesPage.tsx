import React, { useState, useMemo } from 'react';
import { usePlatformStore } from '../store/PlatformContext.js';
import { Device, DeviceStatus } from '../types.js';
import { ActionButton } from '../components/ActionButton.js';
import { Sparkline } from '../components/Sparkline.js';
import { formatRelativeTime } from '../utils/incidentGrouping.js';
import { useToast } from '../components/Toast.js';
import {
  Search,
  Filter,
  Key,
  Radio,
  Copy,
  Check,
  AlertTriangle,
  X,
  Cpu,
  LayoutGrid,
  List,
  MapPin,
} from 'lucide-react';

interface DevicesPageProps {
  onFilterDeviceEvents: (deviceId: string) => void;
}

export const DevicesPage: React.FC<DevicesPageProps> = ({ onFilterDeviceEvents }) => {
  const { state, rotateDeviceKey } = usePlatformStore();
  const { devices, connection } = state;
  const isOffline = connection.status === 'offline';
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [locationFilter, setLocationFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  // Key rotation modal state
  const [rotatedKeyModal, setRotatedKeyModal] = useState<{
    deviceId: string;
    rawKey: string;
  } | null>(null);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<boolean>(false);

  const devicesList = useMemo(() => Object.values(devices), [devices]);

  const uniqueLocations = useMemo(() => {
    const locs = new Set<string>();
    devicesList.forEach((d) => {
      if (d.location_id) locs.add(d.location_id);
    });
    return Array.from(locs);
  }, [devicesList]);

  const filteredDevices = useMemo(() => {
    return devicesList.filter((d) => {
      const matchesSearch =
        d.name.toLowerCase().includes(search.toLowerCase()) ||
        d.id.toLowerCase().includes(search.toLowerCase());

      const matchesStatus = statusFilter === 'all' || d.status === statusFilter;
      const matchesLocation = locationFilter === 'all' || d.location_id === locationFilter;

      return matchesSearch && matchesStatus && matchesLocation;
    });
  }, [devicesList, search, statusFilter, locationFilter]);

  // Group filtered devices by location
  const devicesByLocation = useMemo(() => {
    const map: Record<string, typeof filteredDevices> = {};
    filteredDevices.forEach((d) => {
      const loc = d.location_id || 'Unassigned';
      if (!map[loc]) map[loc] = [];
      map[loc].push(d);
    });
    return map;
  }, [filteredDevices]);

  const handleRotateKey = async (deviceId: string) => {
    if (isOffline) return;
    if (!window.confirm(`Are you sure you want to rotate the access key for device '${deviceId}'?`)) {
      return;
    }

    setRotatingId(deviceId);
    const newKey = await rotateDeviceKey(deviceId);
    setRotatingId(null);

    if (newKey) {
      setCopiedKey(false);
      setRotatedKeyModal({
        deviceId,
        rawKey: newKey,
      });
      showToast('Key rotated', `New key generated for ${deviceId}`);
    } else {
      showToast('Rotation failed', 'Unable to rotate device key', 'error');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
    showToast('Copied to clipboard');
  };

  const renderStatusDot = (status: DeviceStatus) => {
    const isOnline = status === 'online';
    const isStale = status === 'stale';
    const isOfflineDev = status === 'offline';

    return (
      <span className="inline-flex items-center space-x-1.5 text-xs font-mono">
        <span className="relative flex h-2 w-2">
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
        <span
          className={`font-semibold uppercase text-[10px] ${
            isOnline
              ? 'text-[var(--healthy)]'
              : isStale
                ? 'text-[var(--stale)]'
                : 'text-[var(--critical)]'
          }`}
        >
          {status}
        </span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <Cpu className="w-4 h-4 text-[var(--accent)]" />
            <h1 className="text-xl sm:text-2xl font-heading font-bold tracking-tight text-[var(--ink)]">
              Fleet Device Registry
            </h1>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Fleet connectivity status, telemetry cadence, and cryptographic Bearer keys
          </p>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center space-x-1 p-1 rounded-[var(--radius-control,6px)] bg-[var(--surface)] border border-[var(--hairline)] self-start sm:self-auto">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-[var(--radius-control,6px)] transition ${
              viewMode === 'grid'
                ? 'bg-[var(--surface-raised)] text-[var(--accent)] font-semibold shadow-xs'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
            title="Grid view"
            aria-label="Grid view"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('table')}
            className={`p-1.5 rounded-[var(--radius-control,6px)] transition ${
              viewMode === 'table'
                ? 'bg-[var(--surface-raised)] text-[var(--accent)] font-semibold shadow-xs'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
            title="Table view"
            aria-label="Table view"
          >
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-4 flex flex-col md:flex-row items-center justify-between gap-4 shadow-xs">
        <div className="w-full md:w-80 relative">
          <Search className="w-4 h-4 text-[var(--muted)] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by device name or ID..."
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
              <option value="all">All ({devicesList.length})</option>
              <option value="online">Online</option>
              <option value="stale">Stale</option>
              <option value="offline">Offline</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5 text-[var(--muted)]">
            <span className="font-mono text-[11px] uppercase">Location:</span>
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="bg-[var(--canvas)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] px-2.5 py-1.5 text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono"
            >
              <option value="all">All Locations</option>
              {uniqueLocations.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </div>

          <div className="text-[var(--muted)] text-xs font-mono ml-auto">
            Showing <span className="font-bold text-[var(--ink)]">{filteredDevices.length}</span> devices
          </div>
        </div>
      </div>

      {/* Grid View: Grouped by Location with Status Tiles */}
      {viewMode === 'grid' ? (
        <div className="space-y-6">
          {Object.entries(devicesByLocation).map(([locName, locDevices]) => (
            <div
              key={locName}
              className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] p-4 space-y-3 shadow-xs"
            >
              <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] pb-2.5">
                <div className="flex items-center space-x-2">
                  <MapPin className="w-4 h-4 text-[var(--accent)]" />
                  <span className="font-mono font-bold text-xs text-[var(--ink)]">
                    {locName}
                  </span>
                  <span className="text-xs text-[var(--muted)] font-mono">
                    [{locDevices.length} units]
                  </span>
                </div>
                <div className="text-[11px] font-mono text-[var(--muted)]">
                  {locDevices.filter((d) => d.status === 'online').length} online ·{' '}
                  {locDevices.filter((d) => d.status === 'offline').length} offline
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {locDevices.map((device) => {
                  const relativeTime = formatRelativeTime(device.last_seen_at);
                  const isOnline = device.status === 'online';
                  const isStale = device.status === 'stale';
                  const isOfflineDev = device.status === 'offline';
                  const mockActivity = [2, 4, 3, 5, 4, isOnline ? 6 : 1];

                  return (
                    <div
                      key={device.id}
                      className={`p-3.5 rounded-[var(--radius-panel,8px)] bg-[var(--surface-raised)] border ${
                        isOfflineDev
                          ? 'border-l-4 border-l-[var(--critical)] border-[var(--hairline)]'
                          : isStale
                            ? 'border-l-4 border-l-[var(--stale)] border-[var(--hairline)]'
                            : 'border-l-4 border-l-[var(--healthy)] border-[var(--hairline)]'
                      } hover:border-[var(--accent)]/40 transition space-y-3 shadow-xs`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 pr-2">
                          <div className="font-heading font-bold text-xs text-[var(--ink)] truncate">
                            {device.name}
                          </div>
                          <div className="text-[11px] font-mono text-[var(--muted)] truncate select-all">
                            {device.id}
                          </div>
                        </div>
                        {renderStatusDot(device.status)}
                      </div>

                      <div className="flex items-center justify-between text-xs font-mono text-[var(--muted)] pt-2 border-t border-[var(--hairline-subtle)]">
                        <span>Reported:</span>
                        <span
                          className="text-[var(--ink)] font-semibold"
                          title={device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : ''}
                        >
                          {device.last_seen_at ? relativeTime : 'Never'}
                        </span>
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <Sparkline
                          data={mockActivity}
                          width={56}
                          height={18}
                          color={isOnline ? 'var(--healthy)' : 'var(--muted)'}
                        />

                        <div className="flex items-center space-x-1.5">
                          <ActionButton
                            variant="secondary"
                            className="py-1 px-2 text-[11px]"
                            onClick={() => onFilterDeviceEvents(device.id)}
                            title="Filter telemetry stream"
                          >
                            <Radio className="w-3 h-3 mr-1 text-[var(--accent)]" />
                            Events
                          </ActionButton>

                          <ActionButton
                            variant="secondary"
                            isOffline={isOffline}
                            disabled={rotatingId === device.id}
                            className="py-1 px-2 text-[11px]"
                            onClick={() => handleRotateKey(device.id)}
                            title="Rotate access key"
                          >
                            <Key className="w-3 h-3 mr-1" />
                            {rotatingId === device.id ? 'Rotating...' : 'Key'}
                          </ActionButton>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Table View */
        <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[var(--surface-raised)] border-b border-[var(--hairline)] text-[var(--muted)] text-[11px] font-mono font-medium">
                <tr>
                  <th className="px-5 py-3 uppercase tracking-wider font-bold">Device</th>
                  <th className="px-5 py-3 uppercase tracking-wider font-bold">Status</th>
                  <th className="px-5 py-3 uppercase tracking-wider font-bold">Location</th>
                  <th className="px-5 py-3 uppercase tracking-wider font-bold">Last reported</th>
                  <th className="px-5 py-3 uppercase tracking-wider font-bold">Activity</th>
                  <th className="px-5 py-3 uppercase tracking-wider font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline)]">
                {filteredDevices.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-[var(--muted)] font-mono">
                      No devices match the specified search or filter criteria.
                    </td>
                  </tr>
                ) : (
                  filteredDevices.map((device) => {
                    const relativeTime = formatRelativeTime(device.last_seen_at);
                    const isOnline = device.status === 'online';
                    const mockActivity = [2, 4, 3, 5, 4, isOnline ? 6 : 1];

                    return (
                      <tr key={device.id} className="hover:bg-[var(--surface-raised)] transition">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center space-x-2.5">
                            <Cpu className="w-4 h-4 text-[var(--accent)] shrink-0" />
                            <div>
                              <div className="font-heading font-semibold text-[var(--ink)]">{device.name}</div>
                              <div className="text-[11px] text-[var(--muted)] font-mono select-all">
                                {device.id}
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="px-5 py-3.5">{renderStatusDot(device.status)}</td>

                        <td className="px-5 py-3.5 font-mono text-[var(--ink)]">
                          {device.location_id || <span className="text-[var(--muted)]">Unassigned</span>}
                        </td>

                        <td className="px-5 py-3.5 font-mono text-[var(--muted)]">
                          <span title={device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : ''}>
                            {device.last_seen_at ? relativeTime : 'Never'}
                          </span>
                        </td>

                        <td className="px-5 py-3.5">
                          <Sparkline
                            data={mockActivity}
                            width={54}
                            height={18}
                            color={isOnline ? 'var(--healthy)' : 'var(--muted)'}
                          />
                        </td>

                        <td className="px-5 py-3.5 text-right space-x-2 whitespace-nowrap">
                          <ActionButton
                            variant="secondary"
                            onClick={() => onFilterDeviceEvents(device.id)}
                            title="Filter live stream for this device"
                          >
                            <Radio className="w-3.5 h-3.5 mr-1 text-[var(--accent)]" />
                            Events
                          </ActionButton>

                          <ActionButton
                            variant="secondary"
                            isOffline={isOffline}
                            disabled={rotatingId === device.id}
                            onClick={() => handleRotateKey(device.id)}
                            title="Rotate access key"
                          >
                            <Key className="w-3.5 h-3.5 mr-1" />
                            {rotatingId === device.id ? 'Rotating...' : 'Rotate key'}
                          </ActionButton>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Key Rotation Dialog */}
      {rotatedKeyModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] max-w-md w-full p-6 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-3">
              <div className="flex items-center space-x-2 text-[var(--ink)] font-heading font-bold">
                <Key className="w-4 h-4 text-[var(--accent)]" />
                <span>New Bearer Key Generated</span>
              </div>
              <button
                onClick={() => setRotatedKeyModal(null)}
                className="text-[var(--muted)] hover:text-[var(--ink)] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-[var(--stale-bg)] border border-[var(--stale)]/30 rounded-[var(--radius-control,6px)] p-3 text-xs text-[var(--stale)] flex items-start space-x-2 font-mono">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">STORE THIS TOKEN SECURELY</span>
                The raw key is hashed in PostgreSQL and cannot be retrieved again.
              </div>
            </div>

            <div className="space-y-1 text-xs">
              <span className="text-[var(--muted)] font-mono text-[10px] uppercase">Device ID:</span>
              <div className="text-[var(--ink)] font-mono font-semibold">{rotatedKeyModal.deviceId}</div>
            </div>

            <div className="space-y-1 text-xs">
              <span className="text-[var(--muted)] font-mono text-[10px] uppercase">Bearer Authorization Key:</span>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={rotatedKeyModal.rawKey}
                  className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] select-all font-mono text-xs outline-none"
                />
                <button
                  onClick={() => copyToClipboard(rotatedKeyModal.rawKey)}
                  className="px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[#0E1116] font-mono font-bold text-xs flex items-center space-x-1 transition shrink-0"
                >
                  {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedKey ? 'COPIED' : 'COPY'}</span>
                </button>
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--hairline)] flex justify-end">
              <button
                onClick={() => setRotatedKeyModal(null)}
                className="px-4 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[#0E1116] font-heading font-bold text-xs transition"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
