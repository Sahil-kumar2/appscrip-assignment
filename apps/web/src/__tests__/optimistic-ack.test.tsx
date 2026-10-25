// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PlatformProvider, usePlatformStore } from '../store/PlatformContext.js';
import { ActionButton } from '../components/ActionButton.js';
import { Incident } from '../types.js';

// Test harness component to test incident acknowledge interaction
const IncidentAckTestHarness: React.FC<{ initialIncident: Incident; isOffline?: boolean }> = ({
  initialIncident,
  isOffline = false,
}) => {
  const { state, acknowledgeIncident } = usePlatformStore();
  const currentIncident = state.incidents[initialIncident.id] || initialIncident;

  return (
    <div>
      <div data-testid="incident-status">{currentIncident.status}</div>
      <ActionButton
        data-testid="ack-btn"
        isOffline={isOffline}
        variant="warning"
        onClick={() => acknowledgeIncident(initialIncident.id)}
      >
        Acknowledge
      </ActionButton>
    </div>
  );
};

describe('Acknowledge Button Optimistic Update & Rollback', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const testIncident: Incident = {
    id: 'inc-test-optimistic-1',
    rule_id: 'rule-1',
    rule_name: 'Overheat Critical',
    rule_type: 'threshold',
    device_id: 'dev-001',
    device_name: 'Warehouse Sensor',
    dedup_key: 'dedup-test-1',
    status: 'open',
    severity: 'critical',
    occurrence_count: 1,
  };

  it('optimistically updates to acknowledged, then rolls back to open on API failure', async () => {
    // Mock fetch to simulate delayed server error
    let rejectPromise: () => void;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/incidents/inc-test-optimistic-1/ack')) {
        return new Promise((_, reject) => {
          rejectPromise = () => reject(new Error('Internal 500 error'));
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ devices: [], incidents: [testIncident], rules: [], stats: null }),
      });
    });

    render(
      <PlatformProvider
        initialState={{ incidents: { [testIncident.id]: testIncident } }}
        autoFetch={false}
      >
        <IncidentAckTestHarness initialIncident={testIncident} />
      </PlatformProvider>
    );

    // Initial status is 'open'
    expect(screen.getByTestId('incident-status')).toHaveTextContent('open');

    // Click Acknowledge
    const ackBtn = screen.getByTestId('ack-btn');
    fireEvent.click(ackBtn);

    // Verify optimistic update occurred immediately before server responded
    expect(screen.getByTestId('incident-status')).toHaveTextContent('acknowledged');

    // Now trigger server failure
    rejectPromise!();

    // Verify status rolled back to 'open'
    await waitFor(() => {
      expect(screen.getByTestId('incident-status')).toHaveTextContent('open');
    });
  });

  it('keeps acknowledged status on API success', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/incidents/inc-test-optimistic-1/ack')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'acknowledged', incident_id: testIncident.id }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ devices: [], incidents: [testIncident], rules: [], stats: null }),
      });
    });

    render(
      <PlatformProvider
        initialState={{ incidents: { [testIncident.id]: testIncident } }}
        autoFetch={false}
      >
        <IncidentAckTestHarness initialIncident={testIncident} />
      </PlatformProvider>
    );

    expect(screen.getByTestId('incident-status')).toHaveTextContent('open');

    const ackBtn = screen.getByTestId('ack-btn');
    fireEvent.click(ackBtn);

    // Optimistically updates to acknowledged and remains acknowledged
    expect(screen.getByTestId('incident-status')).toHaveTextContent('acknowledged');

    await waitFor(() => {
      expect(screen.getByTestId('incident-status')).toHaveTextContent('acknowledged');
    });
  });

  it('disables ActionButton offline and renders tooltip on hover', () => {
    render(<ActionButton isOffline={true}>Offline Action</ActionButton>);

    const btn = screen.getByRole('button', { name: /Offline Action/i });
    expect(btn).toBeDisabled();

    // Hover over parent container to show tooltip
    const container = btn.parentElement!;
    fireEvent.mouseEnter(container);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent(/Actions are disabled while offline/i);

    fireEvent.mouseLeave(container);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
