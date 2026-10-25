// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConnectionBanner } from '../components/ConnectionBanner.js';
import { ConnectionState } from '../types.js';

describe('ConnectionBanner State Transitions', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders correctly in connected state', () => {
    const connection: ConnectionState = {
      status: 'connected',
      offlineSince: null,
      isStale: false,
      lastSeq: 4200,
    };

    render(<ConnectionBanner connection={connection} />);

    expect(screen.getByTestId('connection-banner-connected')).toBeInTheDocument();
    expect(screen.getByText(/Connected to real-time event stream/i)).toBeInTheDocument();
    expect(screen.getByText(/Sequence #4200/i)).toBeInTheDocument();
  });

  it('renders correctly in reconnecting state with stale data tag', () => {
    const connection: ConnectionState = {
      status: 'reconnecting',
      offlineSince: new Date(),
      isStale: true,
      lastSeq: 4200,
    };

    render(<ConnectionBanner connection={connection} />);

    expect(screen.getByTestId('connection-banner-reconnecting')).toBeInTheDocument();
    expect(screen.getByText(/Reconnecting\.\.\./i)).toBeInTheDocument();
    expect(screen.getByText(/STALE DATA/i)).toBeInTheDocument();
  });

  it('renders correctly in offline state and triggers manual retry', () => {
    const offlineDate = new Date('2026-10-24T14:30:00Z');
    const connection: ConnectionState = {
      status: 'offline',
      offlineSince: offlineDate,
      isStale: true,
      lastSeq: 4200,
    };

    const handleRetry = vi.fn();

    render(<ConnectionBanner connection={connection} onManualReconnect={handleRetry} />);

    expect(screen.getByTestId('connection-banner-offline')).toBeInTheDocument();
    expect(screen.getByText(/Offline since/i)).toBeInTheDocument();
    expect(screen.getByText(/Action buttons disabled/i)).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /Retry Now/i });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });
});
