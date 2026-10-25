import {
  Device,
  Incident,
  Rule,
  LiveEventItem,
  SystemStats,
  StreamChangeLogItem,
  ConnectionState,
} from '../types.js';

export const MAX_LIVE_EVENTS = 250;
const MAX_SEEN_SEQS = 2000;

export interface NormalizedPlatformState {
  devices: Record<string, Device>;
  incidents: Record<string, Incident>;
  rules: Record<string, Rule>;
  liveEvents: LiveEventItem[];
  stats: SystemStats | null;
  lastSeq: number;
  seenSeqs: Set<number>;
  connection: ConnectionState;
}

export const initialPlatformState: NormalizedPlatformState = {
  devices: {},
  incidents: {},
  rules: {},
  liveEvents: [],
  stats: null,
  lastSeq: 0,
  seenSeqs: new Set<number>(),
  connection: {
    status: 'connected',
    offlineSince: null,
    isStale: false,
    lastSeq: 0,
  },
};

export type PlatformAction =
  | {
      type: 'INIT_STATE';
      payload: {
        devices: Device[];
        incidents: Incident[];
        rules: Rule[];
        stats: SystemStats;
      };
    }
  | { type: 'APPLY_CHANGE'; change: StreamChangeLogItem }
  | { type: 'APPLY_BATCH'; changes: StreamChangeLogItem[] }
  | {
      type: 'SET_CONNECTION';
      status: 'connected' | 'reconnecting' | 'offline';
      offlineSince?: Date | null;
    }
  | { type: 'UPDATE_LAST_SEQ'; seq: number }
  | {
      type: 'OPTIMISTIC_UPDATE_INCIDENT';
      id: string;
      patch: Partial<Incident>;
    }
  | {
      type: 'ROLLBACK_INCIDENT';
      id: string;
      backup: Incident;
    }
  | { type: 'ADD_LIVE_EVENT'; event: LiveEventItem };

/**
 * Pure reducer function to apply a single change_log entry idempotently.
 * Ignores any change with seq <= lastSeq or already in seenSeqs.
 */
export function applyChangeLogItem(
  state: NormalizedPlatformState,
  item: StreamChangeLogItem
): NormalizedPlatformState {
  const seq = Number(item.seq);

  // Idempotency: Ignore already-seen sequence IDs
  if (state.seenSeqs.has(seq)) {
    return state;
  }

  // Clone seenSeqs and maintain bounded size
  const nextSeenSeqs = new Set(state.seenSeqs);
  nextSeenSeqs.add(seq);
  if (nextSeenSeqs.size > MAX_SEEN_SEQS) {
    // Delete oldest entries
    const it = nextSeenSeqs.values();
    nextSeenSeqs.delete(it.next().value as number);
  }

  const nextLastSeq = Math.max(state.lastSeq, seq);
  const nextConnection = {
    ...state.connection,
    lastSeq: nextLastSeq,
  };

  const entity = item.entity || item.entity_type;
  const entityId = item.entity_id;
  const op = item.op || item.action || 'UPDATE';
  const data = item.data || item.payload || {};

  // 1. Devices Entity
  if (entity === 'device') {
    const nextDevices = { ...state.devices };
    if (op === 'DELETE') {
      delete nextDevices[entityId];
    } else {
      const existing = nextDevices[entityId] || {
        id: entityId,
        name: data.name || entityId,
        location_id: data.location_id || 'unknown',
        status: 'online',
        last_seq: 0,
      };
      nextDevices[entityId] = {
        ...existing,
        ...data,
        id: entityId,
      };
    }
    return {
      ...state,
      devices: nextDevices,
      lastSeq: nextLastSeq,
      seenSeqs: nextSeenSeqs,
      connection: nextConnection,
    };
  }

  // 2. Incidents Entity
  if (entity === 'incident') {
    const nextIncidents = { ...state.incidents };
    if (op === 'DELETE') {
      delete nextIncidents[entityId];
    } else {
      const existing = nextIncidents[entityId] || {
        id: entityId,
        rule_id: data.rule_id || '',
        rule_name: data.rule_name || 'Incident',
        rule_type: data.rule_type || 'threshold',
        device_id: data.device_id || '',
        device_name: data.device_name || data.device_id || 'Device',
        dedup_key: data.dedup_key || entityId,
        status: data.status || 'open',
        severity: data.severity || 'warning',
        occurrence_count: Number(data.occurrence_count || 1),
      };
      nextIncidents[entityId] = {
        ...existing,
        ...data,
        id: entityId,
      };
    }
    return {
      ...state,
      incidents: nextIncidents,
      lastSeq: nextLastSeq,
      seenSeqs: nextSeenSeqs,
      connection: nextConnection,
    };
  }

  // 3. Rules Entity
  if (entity === 'rule') {
    const nextRules = { ...state.rules };
    if (op === 'DELETE') {
      delete nextRules[entityId];
    } else {
      const existing = nextRules[entityId] || {
        id: entityId,
        name: data.name || entityId,
        type: data.type || data.rule_type || 'threshold',
        rule_type: data.rule_type || data.type || 'threshold',
        config: data.config || {},
        scope: data.scope || { type: 'all' },
        scope_type: data.scope_type || 'all',
        severity: data.severity || 'warning',
        enabled: data.enabled ?? true,
        cooldown: data.cooldown ?? 0,
      };
      nextRules[entityId] = {
        ...existing,
        ...data,
        id: entityId,
      };
    }
    return {
      ...state,
      rules: nextRules,
      lastSeq: nextLastSeq,
      seenSeqs: nextSeenSeqs,
      connection: nextConnection,
    };
  }

  // 4. Events Entity (Live Stream)
  if (entity === 'event') {
    const newEvent: LiveEventItem = {
      id: entityId || data.event_id || `ev-${seq}`,
      event_id: data.event_id || entityId,
      device_id: data.device_id || 'unknown',
      seq: Number(data.seq || seq),
      ts: data.ts || item.created_at,
      received_at: data.received_at || item.created_at,
      type: data.type || 'telemetry',
      payload: data.payload ?? data,
      processing_status: data.processing_status || 'pending',
      is_late: Boolean(data.is_late),
      is_duplicate: Boolean(data.is_duplicate || data.status === 'duplicate'),
    };

    const nextLiveEvents = [newEvent, ...state.liveEvents].slice(0, MAX_LIVE_EVENTS);

    return {
      ...state,
      liveEvents: nextLiveEvents,
      lastSeq: nextLastSeq,
      seenSeqs: nextSeenSeqs,
      connection: nextConnection,
    };
  }

  return {
    ...state,
    lastSeq: nextLastSeq,
    seenSeqs: nextSeenSeqs,
    connection: nextConnection,
  };
}

/**
 * Pure reducer function to apply a batch of change_log entries.
 */
export function applyChangeLogBatch(
  state: NormalizedPlatformState,
  items: StreamChangeLogItem[]
): NormalizedPlatformState {
  let currentState = state;
  for (const item of items) {
    currentState = applyChangeLogItem(currentState, item);
  }
  return currentState;
}

export function platformReducer(
  state: NormalizedPlatformState,
  action: PlatformAction
): NormalizedPlatformState {
  switch (action.type) {
    case 'INIT_STATE': {
      const devicesMap: Record<string, Device> = {};
      action.payload.devices.forEach((d) => {
        devicesMap[d.id] = d;
      });

      const incidentsMap: Record<string, Incident> = {};
      action.payload.incidents.forEach((i) => {
        incidentsMap[i.id] = i;
      });

      const rulesMap: Record<string, Rule> = {};
      action.payload.rules.forEach((r) => {
        rulesMap[r.id] = r;
      });

      return {
        ...state,
        devices: devicesMap,
        incidents: incidentsMap,
        rules: rulesMap,
        stats: action.payload.stats,
        connection: {
          ...state.connection,
          isStale: false,
        },
      };
    }

    case 'APPLY_CHANGE':
      return applyChangeLogItem(state, action.change);

    case 'APPLY_BATCH':
      return applyChangeLogBatch(state, action.changes);

    case 'SET_CONNECTION': {
      const isOfflineOrReconnecting =
        action.status === 'offline' || action.status === 'reconnecting';
      return {
        ...state,
        connection: {
          ...state.connection,
          status: action.status,
          offlineSince:
            action.offlineSince !== undefined
              ? action.offlineSince
              : isOfflineOrReconnecting
                ? state.connection.offlineSince || new Date()
                : null,
          isStale: isOfflineOrReconnecting,
        },
      };
    }

    case 'OPTIMISTIC_UPDATE_INCIDENT': {
      const existing = state.incidents[action.id];
      if (!existing) return state;
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [action.id]: {
            ...existing,
            ...action.patch,
          },
        },
      };
    }

    case 'ROLLBACK_INCIDENT': {
      return {
        ...state,
        incidents: {
          ...state.incidents,
          [action.id]: action.backup,
        },
      };
    }

    case 'ADD_LIVE_EVENT': {
      return {
        ...state,
        liveEvents: [action.event, ...state.liveEvents].slice(0, MAX_LIVE_EVENTS),
      };
    }

    case 'UPDATE_LAST_SEQ': {
      const nextLastSeq = Math.max(state.lastSeq, action.seq);
      return {
        ...state,
        lastSeq: nextLastSeq,
        connection: {
          ...state.connection,
          lastSeq: nextLastSeq,
        },
      };
    }

    default:
      return state;
  }
}
