import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
} from 'react';
import {
  NormalizedPlatformState,
  initialPlatformState,
  platformReducer,
} from './platformReducer.js';
import { authFetch, OPERATOR_TOKEN } from '../api.js';
import { StreamChangeLogItem, Incident } from '../types.js';

interface PlatformContextValue {
  state: NormalizedPlatformState;
  acknowledgeIncident: (id: string, actor?: string, reason?: string) => Promise<boolean>;
  resolveIncident: (id: string, actor?: string, reason?: string) => Promise<boolean>;
  rotateDeviceKey: (id: string) => Promise<string | null>;
  createRule: (rulePayload: any) => Promise<boolean>;
  deleteRule: (id: string) => Promise<boolean>;
  toggleRuleEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  requeueDeadLetter: (payload: { target?: string; id?: string }) => Promise<boolean>;
  retryNotification: (id: string) => Promise<boolean>;
  retryDeadNotifications: (incidentId?: string) => Promise<boolean>;
  refetchState: () => Promise<void>;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export const PlatformProvider: React.FC<{
  children: ReactNode;
  initialState?: Partial<NormalizedPlatformState>;
  autoFetch?: boolean;
}> = ({ children, initialState, autoFetch = true }) => {
  const [state, dispatch] = useReducer(platformReducer, {
    ...initialPlatformState,
    ...initialState,
  });

  const lastSeqRef = useRef<number>(0);
  const rafBufferRef = useRef<StreamChangeLogItem[]>([]);
  const rafScheduledRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const offlineTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Keep lastSeqRef synchronized with state.lastSeq
  useEffect(() => {
    if (state.lastSeq > lastSeqRef.current) {
      lastSeqRef.current = state.lastSeq;
    }
  }, [state.lastSeq]);

  // REST state fetcher for initialization and 'resync_required'
  const fetchInitialState = useCallback(async () => {
    try {
      const [devRes, incRes, rulesRes, statsRes] = await Promise.all([
        authFetch('/api/devices')
          .then((r) => r.json())
          .catch(() => ({ devices: [] })),
        authFetch('/api/incidents?limit=100')
          .then((r) => r.json())
          .catch(() => ({ incidents: [] })),
        authFetch('/api/rules')
          .then((r) => r.json())
          .catch(() => ({ rules: [] })),
        authFetch('/api/stats')
          .then((r) => r.json())
          .catch(() => null),
      ]);

      dispatch({
        type: 'INIT_STATE',
        payload: {
          devices: devRes.devices || [],
          incidents: incRes.incidents || [],
          rules: rulesRes.rules || [],
          stats: statsRes,
        },
      });
    } catch (err) {
      console.error('Error fetching platform state:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (autoFetch) {
      void fetchInitialState();
    }
  }, [autoFetch, fetchInitialState]);

  // Real-Time SSE Stream Hook with requestAnimationFrame Burst Batching
  useEffect(() => {
    let isMounted = true;

    const connectSSE = () => {
      if (!isMounted) return;
      if (typeof EventSource === 'undefined') {
        console.warn('EventSource is not supported in this environment');
        return;
      }

      const currentSeq = lastSeqRef.current;
      const url =
        currentSeq > 0
          ? `/api/stream?last_event_id=${currentSeq}&token=${encodeURIComponent(OPERATOR_TOKEN)}`
          : `/api/stream?token=${encodeURIComponent(OPERATOR_TOKEN)}`;

      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        if (!isMounted) return;
        if (offlineTimeoutRef.current) {
          clearTimeout(offlineTimeoutRef.current);
          offlineTimeoutRef.current = null;
        }
        dispatch({
          type: 'SET_CONNECTION',
          status: 'connected',
          offlineSince: null,
        });
      };

      // Handle full resync requirement
      es.addEventListener('resync_required', (event: MessageEvent) => {
        if (!isMounted) return;
        console.warn('Received SSE resync_required event; refetching platform state via REST');
        try {
          if (event.data) {
            const data = JSON.parse(event.data);
            const latestSeq = Number(data.latest_seq || 0);
            if (latestSeq > lastSeqRef.current) {
              lastSeqRef.current = latestSeq;
              dispatch({ type: 'UPDATE_LAST_SEQ', seq: latestSeq });
            }
          }
        } catch {
          // ignore json parse error
        }
        void fetchInitialState();
      });

      // Handle real-time change log entries
      es.addEventListener('change', (event: MessageEvent) => {
        if (!isMounted) return;
        try {
          const item = JSON.parse(event.data) as StreamChangeLogItem;
          rafBufferRef.current.push(item);
          // Memory leak defense: cap in-memory burst buffer if window is backgrounded/minimized
          if (rafBufferRef.current.length > 500) {
            rafBufferRef.current = rafBufferRef.current.slice(-500);
          }

          // Render bursts in batches via requestAnimationFrame; fallback to setTimeout when tab is backgrounded
          if (!rafScheduledRef.current) {
            rafScheduledRef.current = true;
            const isDocHidden = typeof document !== 'undefined' && document.hidden;
            const schedule =
              !isDocHidden && typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (cb: () => void) => setTimeout(cb, 50);

            schedule(() => {
              rafScheduledRef.current = false;
              if (rafBufferRef.current.length > 0 && isMounted) {
                const batch = rafBufferRef.current;
                rafBufferRef.current = [];
                dispatch({ type: 'APPLY_BATCH', changes: batch });
              }
            });
          }
        } catch (err) {
          console.error('Error parsing SSE event message:', err);
        }
      });

      es.onerror = () => {
        if (!isMounted) return;
        es.close();
        eventSourceRef.current = null;

        // Transition to reconnecting immediately
        dispatch({ type: 'SET_CONNECTION', status: 'reconnecting' });

        // If not connected after 8 seconds, transition to offline state
        if (!offlineTimeoutRef.current) {
          offlineTimeoutRef.current = setTimeout(() => {
            if (isMounted) {
              dispatch({
                type: 'SET_CONNECTION',
                status: 'offline',
                offlineSince: new Date(),
              });
            }
          }, 8000);
        }

        // Schedule next reconnect attempt
        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          connectSSE();
        }, 3000);
      };
    };

    connectSSE();

    const handleOffline = () => {
      if (!isMounted) return;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      dispatch({
        type: 'SET_CONNECTION',
        status: 'offline',
        offlineSince: new Date(),
      });
    };

    const handleOnline = () => {
      if (!isMounted) return;
      connectSSE();
      void fetchInitialState();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      isMounted = false;
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (offlineTimeoutRef.current) clearTimeout(offlineTimeoutRef.current);
    };
  }, [fetchInitialState]);

  // Periodic stats refresh (every 10s)
  useEffect(() => {
    const timer = setInterval(() => {
      authFetch('/api/stats')
        .then((r) => r.json())
        .then((stats) => {
          if (stats) {
            dispatch({
              type: 'INIT_STATE',
              payload: {
                devices: Object.values(state.devices),
                incidents: Object.values(state.incidents),
                rules: Object.values(state.rules),
                stats,
              },
            });
          }
        })
        .catch(() => {});
    }, 10000);

    return () => clearInterval(timer);
  }, [state.devices, state.incidents, state.rules]);

  // Optimistic Acknowledge with Rollback on Failure
  const acknowledgeIncident = async (
    id: string,
    actor: string = 'operator:web',
    reason: string = 'Operator acknowledged in console'
  ): Promise<boolean> => {
    const existing = state.incidents[id] || {
      id,
      rule_id: '',
      rule_name: 'Incident',
      rule_type: 'threshold',
      device_id: '',
      device_name: 'Device',
      dedup_key: id,
      status: 'open',
      severity: 'warning',
      occurrence_count: 1,
    };

    const backup: Incident = { ...existing };

    // Optimistic Update
    dispatch({
      type: 'OPTIMISTIC_UPDATE_INCIDENT',
      id,
      patch: {
        status: 'acknowledged',
        acknowledged_at: new Date().toISOString(),
      },
    });

    try {
      const res = await authFetch(`/api/incidents/${id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor, reason }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Acknowledge failed with HTTP ${res.status}`);
      }

      return true;
    } catch (err: any) {
      console.error('Failed to acknowledge incident, rolling back:', err);
      // Rollback on failure
      dispatch({
        type: 'ROLLBACK_INCIDENT',
        id,
        backup,
      });
      alert(`Action failed: ${err.message || 'Unknown error'}`);
      return false;
    }
  };

  // Optimistic Resolve with Rollback on Failure
  const resolveIncident = async (
    id: string,
    actor: string = 'operator:web',
    reason: string = 'Operator resolved in console'
  ): Promise<boolean> => {
    const existing = state.incidents[id];
    if (!existing) return false;

    const backup: Incident = { ...existing };

    // Optimistic Update
    dispatch({
      type: 'OPTIMISTIC_UPDATE_INCIDENT',
      id,
      patch: {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      },
    });

    try {
      const res = await authFetch(`/api/incidents/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor, reason }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Resolve failed with HTTP ${res.status}`);
      }

      return true;
    } catch (err: any) {
      console.error('Failed to resolve incident, rolling back:', err);
      // Rollback on failure
      dispatch({
        type: 'ROLLBACK_INCIDENT',
        id,
        backup,
      });
      alert(`Action failed: ${err.message || 'Unknown error'}`);
      return false;
    }
  };

  // Device key rotation
  const rotateDeviceKey = async (id: string): Promise<string | null> => {
    try {
      const res = await authFetch(`/api/devices/${id}/rotate-key`, { method: 'POST' });
      if (!res.ok) throw new Error('Rotate key failed');
      const data = await res.json();
      return data.raw_key || null;
    } catch (err) {
      console.error(err);
      return null;
    }
  };

  // Rules CRUD
  const createRule = async (payload: any): Promise<boolean> => {
    try {
      const res = await authFetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create rule');
      }
      const data = await res.json();
      if (data.rule) {
        dispatch({
          type: 'APPLY_CHANGE',
          change: {
            seq: lastSeqRef.current + 1,
            entity: 'rule',
            entity_id: data.rule.id,
            op: 'INSERT',
            data: data.rule,
            created_at: new Date().toISOString(),
          },
        });
      }
      return true;
    } catch (err: any) {
      alert(`Error creating rule: ${err.message}`);
      return false;
    }
  };

  const deleteRule = async (id: string): Promise<boolean> => {
    try {
      const res = await authFetch(`/api/rules/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete rule');
      dispatch({
        type: 'APPLY_CHANGE',
        change: {
          seq: lastSeqRef.current + 1,
          entity: 'rule',
          entity_id: id,
          op: 'DELETE',
          data: { id },
          created_at: new Date().toISOString(),
        },
      });
      return true;
    } catch (err: any) {
      alert(`Error deleting rule: ${err.message}`);
      return false;
    }
  };

  const toggleRuleEnabled = async (id: string, enabled: boolean): Promise<boolean> => {
    try {
      const res = await authFetch(`/api/rules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('Failed to toggle rule');
      const data = await res.json();
      if (data.rule) {
        dispatch({
          type: 'APPLY_CHANGE',
          change: {
            seq: lastSeqRef.current + 1,
            entity: 'rule',
            entity_id: id,
            op: 'UPDATE',
            data: data.rule,
            created_at: new Date().toISOString(),
          },
        });
      }
      return true;
    } catch (err: any) {
      alert(`Error updating rule: ${err.message}`);
      return false;
    }
  };

  // Dead Letter & Notification Requeuing
  const requeueDeadLetter = async (payload: { target?: string; id?: string }): Promise<boolean> => {
    try {
      const res = await authFetch('/api/dead-letters/requeue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const retryNotification = async (id: string): Promise<boolean> => {
    try {
      const res = await authFetch(`/api/notifications/${id}/retry`, { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    }
  };

  const retryDeadNotifications = async (incidentId?: string): Promise<boolean> => {
    try {
      const res = await authFetch('/api/notifications/retry-dead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(incidentId ? { incident_id: incidentId } : {}),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  return (
    <PlatformContext.Provider
      value={{
        state,
        acknowledgeIncident,
        resolveIncident,
        rotateDeviceKey,
        createRule,
        deleteRule,
        toggleRuleEnabled,
        requeueDeadLetter,
        retryNotification,
        retryDeadNotifications,
        refetchState: fetchInitialState,
      }}
    >
      {children}
    </PlatformContext.Provider>
  );
};

export function usePlatformStore(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    throw new Error('usePlatformStore must be used within a PlatformProvider');
  }
  return ctx;
}
