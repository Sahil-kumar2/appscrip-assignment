// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LiveIndicator } from '../components/LiveIndicator.js';
import { ConnectionState } from '../types.js';

describe('LiveIndicator Connection Indicator States', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders green Live dot in connected state', () => {
    const connection: ConnectionState = {
      status: 'connected',
      offlineSince: null,
      isStale: false,
      lastSeq: 5400,
    };

    render(<LiveIndicator connection={connection} />);

    const indicator = screen.getByTestId('live-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute('data-status', 'connected');
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('renders amber dot with Reconnecting in reconnecting state', () => {
    const connection: ConnectionState = {
      status: 'reconnecting',
      offlineSince: new Date(),
      isStale: true,
      lastSeq: 5400,
    };

    render(<LiveIndicator connection={connection} />);

    const indicator = screen.getByTestId('live-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute('data-status', 'reconnecting');
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
  });

  it('renders red dot with Offline in offline state and triggers reconnect on click', () => {
    const handleReconnect = vi.fn();
    const connection: ConnectionState = {
      status: 'offline',
      offlineSince: new Date('2026-10-24T18:00:00Z'),
      isStale: true,
      lastSeq: 5400,
    };

    render(<LiveIndicator connection={connection} onReconnect={handleReconnect} />);

    const indicator = screen.getByTestId('live-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute('data-status', 'offline');
    expect(screen.getByText('Offline')).toBeInTheDocument();

    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(handleReconnect).toHaveBeenCalledTimes(1);
  });
});
