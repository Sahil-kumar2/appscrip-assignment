import React, { useState, useEffect, useRef } from 'react';
import { PlatformProvider, usePlatformStore } from './store/PlatformContext.js';
import { ThemeProvider } from './store/ThemeContext.js';
import { ToastProvider, useToast } from './components/Toast.js';
import { CommandBar } from './components/CommandBar.js';
import { IncidentRail } from './components/IncidentRail.js';
import { ConnectionBanner } from './components/ConnectionBanner.js';
import { CommandPalette } from './components/CommandPalette.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { DevicesPage } from './pages/DevicesPage.js';
import { LiveEventsPage } from './pages/LiveEventsPage.js';
import { IncidentsPage } from './pages/IncidentsPage.js';
import { RulesPage } from './pages/RulesPage.js';
import { OpsPage } from './pages/OpsPage.js';
import { ExplainModal } from './components/ExplainModal.js';
import { IncidentDetailDrawer } from './components/IncidentDetailDrawer.js';

function DashboardLayout() {
  const { state, refetchState, acknowledgeIncident, resolveIncident } = usePlatformStore();
  const { connection, incidents, stats } = state;
  const isOffline = connection.status === 'offline';
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<string>('overview');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [selectedExplainEventId, setSelectedExplainEventId] = useState<string | null>(null);
  const [selectedDeviceFilter, setSelectedDeviceFilter] = useState<string | null>(null);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const [isRailOpen, setIsRailOpen] = useState<boolean>(true);

  // Track reconnection to show "Caught up" toast
  const prevConnectionStatusRef = useRef<string>(connection.status);
  const prevSeqRef = useRef<number>(connection.lastSeq);

  useEffect(() => {
    const prevStatus = prevConnectionStatusRef.current;
    const currentStatus = connection.status;

    if (
      (prevStatus === 'reconnecting' || prevStatus === 'offline') &&
      currentStatus === 'connected'
    ) {
      const missedEvents = Math.max(0, connection.lastSeq - prevSeqRef.current);
      showToast(
        'Caught up',
        missedEvents > 0
          ? `${missedEvents} missed events replayed from stream`
          : 'Reconnected to real-time telemetry stream'
      );
    }

    prevConnectionStatusRef.current = currentStatus;
    if (currentStatus === 'connected') {
      prevSeqRef.current = connection.lastSeq;
    }
  }, [connection.status, connection.lastSeq, showToast]);

  const openIncidentsCount = Object.values(incidents).filter(
    (i) => i.status === 'open' || i.status === 'acknowledged'
  ).length;

  // Global Cmd/Ctrl+K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--ink)] flex flex-col font-sans">
      {/* 1. Slim Top Command Bar */}
      <CommandBar
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          if (tab !== 'incidents') {
            setSelectedIncidentId(null);
          }
        }}
        openIncidentsCount={openIncidentsCount}
        connection={connection}
        onReconnect={refetchState}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        stats={stats}
        isRailOpen={isRailOpen}
        onToggleRail={() => setIsRailOpen((prev) => !prev)}
      />

      {/* Connection Alert Banner (Only expands visually when reconnecting or offline) */}
      <ConnectionBanner connection={connection} onManualReconnect={refetchState} />

      {/* 2. Main Workspace Layout with Right-Hand Incident Rail */}
      <div className="flex-1 flex min-w-0 h-[calc(100vh-3.5rem)] overflow-hidden">
        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 max-w-7xl w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewPage
              onNavigateTab={(tab) => setActiveTab(tab)}
              onSelectIncident={(id) => setSelectedIncidentId(id)}
            />
          )}

          {activeTab === 'devices' && (
            <DevicesPage
              onFilterDeviceEvents={(deviceId) => {
                setSelectedDeviceFilter(deviceId);
                setActiveTab('events');
              }}
            />
          )}

          {activeTab === 'events' && (
            <LiveEventsPage
              initialDeviceFilter={selectedDeviceFilter}
              onClearInitialDeviceFilter={() => setSelectedDeviceFilter(null)}
              onExplainEvent={(evId) => setSelectedExplainEventId(evId)}
            />
          )}

          {activeTab === 'incidents' && (
            <IncidentsPage
              selectedIncidentId={selectedIncidentId}
              onSelectIncident={setSelectedIncidentId}
              onExplainEvent={(evId) => setSelectedExplainEventId(evId)}
            />
          )}

          {activeTab === 'rules' && <RulesPage />}

          {activeTab === 'ops' && <OpsPage />}
        </main>

        {/* 3. Persistent Right-Hand Incident Rail */}
        <IncidentRail
          incidents={incidents}
          selectedIncidentId={selectedIncidentId}
          onSelectIncident={(id) => setSelectedIncidentId(id)}
          onAcknowledge={(id) =>
            acknowledgeIncident(id, 'operator:rail', 'Operator acknowledged via Incident Rail')
          }
          onResolve={(id) =>
            resolveIncident(id, 'operator:rail', 'Operator resolved via Incident Rail')
          }
          isOffline={isOffline}
          isOpen={isRailOpen}
          onToggleOpen={() => setIsRailOpen((prev) => !prev)}
        />
      </div>

      {/* Global Slide-Over Incident Drawer (Triggerable from anywhere, including Incident Rail) */}
      {selectedIncidentId && activeTab !== 'incidents' && (
        <IncidentDetailDrawer
          incidentId={selectedIncidentId}
          isOffline={isOffline}
          onClose={() => setSelectedIncidentId(null)}
          onAcknowledge={(id) =>
            acknowledgeIncident(id, 'operator:ui', 'Acknowledged from drawer')
          }
          onResolve={(id) =>
            resolveIncident(id, 'operator:ui', 'Resolved from drawer')
          }
          onExplainEvent={(evId) => setSelectedExplainEventId(evId)}
        />
      )}

      {/* Explain Inspector Modal */}
      {selectedExplainEventId && (
        <ExplainModal
          eventId={selectedExplainEventId}
          onClose={() => setSelectedExplainEventId(null)}
        />
      )}

      {/* Command Palette */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        onNavigateTab={(tab) => {
          setActiveTab(tab);
          if (tab !== 'incidents') setSelectedIncidentId(null);
        }}
        onSelectIncident={(id) => {
          setSelectedIncidentId(id);
          setActiveTab('incidents');
        }}
        onFilterDevice={(devId) => {
          setSelectedDeviceFilter(devId);
          setActiveTab('events');
        }}
      />
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <PlatformProvider>
        <ToastProvider>
          <DashboardLayout />
        </ToastProvider>
      </PlatformProvider>
    </ThemeProvider>
  );
}

export default App;
