import { randomUUID } from 'node:crypto';
import { IngestEvent, createLogger } from '@aps/shared';
import { FileBackedBuffer } from './buffer.js';

const logger = createLogger({ service: 'simulated-device' });

export type DeviceState = 'connected' | 'offline' | 'replaying';

export interface SimulatedDeviceSpec {
  deviceId: string;
  apiKey: string;
  name: string;
  dataDir?: string;
}

export interface SendBatchResult {
  success: boolean;
  status?: number;
  acceptedCount?: number;
  duplicateCount?: number;
  rejectedCount?: number;
  retryAfterSec?: number;
  error?: string;
}

export interface ReplayOptions {
  chunkSize?: number;
  resendAcked?: boolean;
  shuffleChunks?: boolean;
}

export class SimulatedDevice {
  public readonly deviceId: string;
  public readonly apiKey: string;
  public readonly name: string;
  public readonly buffer: FileBackedBuffer;

  private state: DeviceState = 'connected';
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private networkDisabled = false;
  private uptimeSeconds = 0;
  private tickCount = 0;
  private ackedEventCache: Map<string, IngestEvent> = new Map();

  constructor(spec: SimulatedDeviceSpec) {
    this.deviceId = spec.deviceId;
    this.apiKey = spec.apiKey;
    this.name = spec.name;
    this.buffer = new FileBackedBuffer(spec.deviceId, spec.dataDir);

    logger.info(
      {
        deviceId: this.deviceId,
        initialBuffer: this.buffer.getBufferSize(),
        lastSeq: this.buffer.getLastSeq(),
      },
      'SimulatedDevice initialized'
    );
  }

  public getState(): DeviceState {
    return this.state;
  }

  public getPausedUntil(): number {
    return this.pausedUntil;
  }

  public isNetworkDisabled(): boolean {
    return this.networkDisabled;
  }

  public setNetworkDisabled(disabled: boolean): void {
    if (this.networkDisabled === disabled) return;
    this.networkDisabled = disabled;

    if (disabled) {
      this.transitionState('offline', 'network simulated outage / pause');
    } else {
      logger.info({ deviceId: this.deviceId }, 'Device network reconnected');
      // When reconnected, if buffer has pending events, transition to replaying
      if (this.buffer.getBufferSize() > 0) {
        this.transitionState(
          'replaying',
          `replaying ${this.buffer.getBufferSize()} buffered events`
        );
      } else {
        this.transitionState('connected', 'network restored');
      }
    }
  }

  public transitionState(newState: DeviceState, reason?: string): void {
    if (this.state === newState && newState !== 'replaying') return;
    const oldState = this.state;
    this.state = newState;

    const msg = `[STATE CHANGE] ${this.deviceId}: ${oldState} -> ${newState}${reason ? ` (${reason})` : ''}`;
    console.log(msg);
    logger.info(
      {
        deviceId: this.deviceId,
        fromState: oldState,
        toState: newState,
        reason,
        bufferSize: this.buffer.getBufferSize(),
      },
      msg
    );
  }

  // --- Event Generators ---

  public generateTelemetry(baseTemp = 22.0, noise = 2.5): IngestEvent {
    this.tickCount++;
    this.uptimeSeconds += 2;

    const tempNoise = (Math.random() * 2 - 1) * noise;
    const temp = +(baseTemp + tempNoise).toFixed(2);
    const humidity = +(45 + (Math.random() * 10 - 5)).toFixed(1);
    const battery = +(95 - (this.tickCount % 100) * 0.1).toFixed(1);

    const event: IngestEvent = {
      event_id: randomUUID(),
      device_id: this.deviceId,
      seq: this.buffer.nextSeq(),
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: {
        temperature: temp,
        humidity,
        battery,
      },
      schema_version: 1,
    };

    this.buffer.append(event);
    this.ackedEventCache.set(event.event_id, event);
    return event;
  }

  public generateHeartbeat(): IngestEvent {
    this.uptimeSeconds += 2;
    const event: IngestEvent = {
      event_id: randomUUID(),
      device_id: this.deviceId,
      seq: this.buffer.nextSeq(),
      ts: new Date().toISOString(),
      type: 'device.heartbeat',
      payload: {
        uptime_seconds: this.uptimeSeconds,
        rssi: -60 - Math.floor(Math.random() * 20),
        status: 'nominal',
      },
      schema_version: 1,
    };

    this.buffer.append(event);
    this.ackedEventCache.set(event.event_id, event);
    return event;
  }

  public generateError(
    errorCode = 'ERR_SENSOR_TIMEOUT',
    detail = 'Sensor read timeout after 500ms'
  ): IngestEvent {
    const event: IngestEvent = {
      event_id: randomUUID(),
      device_id: this.deviceId,
      seq: this.buffer.nextSeq(),
      ts: new Date().toISOString(),
      type: 'device.error',
      payload: {
        error_code: errorCode,
        detail,
        severity: 'warning',
      },
      schema_version: 1,
    };

    this.buffer.append(event);
    this.ackedEventCache.set(event.event_id, event);
    return event;
  }

  public generateSpike(temp = 92.5): IngestEvent {
    const event: IngestEvent = {
      event_id: randomUUID(),
      device_id: this.deviceId,
      seq: this.buffer.nextSeq(),
      ts: new Date().toISOString(),
      type: 'telemetry',
      payload: {
        temperature: temp,
        anomaly: 'high_temperature_spike',
        humidity: 40.0,
        battery: 90.0,
      },
      schema_version: 1,
    };

    this.buffer.append(event);
    this.ackedEventCache.set(event.event_id, event);
    return event;
  }

  public generateMalformed(): any {
    // Generates an invalid event to test per-event rejection
    const coin = Math.random();
    if (coin < 0.33) {
      // Future timestamp > 5 mins
      return {
        event_id: randomUUID(),
        device_id: this.deviceId,
        seq: this.buffer.nextSeq(),
        ts: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        type: 'telemetry',
        payload: { temperature: 25 },
        schema_version: 1,
      };
    } else if (coin < 0.66) {
      // Invalid UUID
      return {
        event_id: 'not-a-valid-uuid',
        device_id: this.deviceId,
        seq: this.buffer.nextSeq(),
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 25 },
        schema_version: 1,
      };
    } else {
      // Unsupported schema version
      return {
        event_id: randomUUID(),
        device_id: this.deviceId,
        seq: this.buffer.nextSeq(),
        ts: new Date().toISOString(),
        type: 'telemetry',
        payload: { temperature: 25 },
        schema_version: 99,
      };
    }
  }

  public generateDuplicate(): IngestEvent | null {
    // Pick an already-acknowledged or cached event to resend
    const ackedIds = this.buffer.getAcknowledgedIds();
    if (ackedIds.length > 0) {
      const id = ackedIds[Math.floor(Math.random() * ackedIds.length)];
      if (this.ackedEventCache.has(id)) {
        return { ...this.ackedEventCache.get(id)! };
      }
    }
    if (this.ackedEventCache.size > 0) {
      const keys = Array.from(this.ackedEventCache.keys());
      const id = keys[Math.floor(Math.random() * keys.length)];
      return { ...this.ackedEventCache.get(id)! };
    }
    return null;
  }

  // --- Transmission & Replay ---

  public async transmitBatch(
    apiUrl: string,
    options: {
      maxBatchSize?: number;
      fetchFn?: typeof fetch;
      injectedEvents?: any[];
      replayOptions?: ReplayOptions;
    } = {}
  ): Promise<SendBatchResult> {
    const fetchImpl = options.fetchFn || fetch;
    const maxBatch = options.maxBatchSize || 50;

    if (this.networkDisabled) {
      return { success: false, error: 'Network is offline' };
    }

    if (Date.now() < this.pausedUntil) {
      const remainingSec = Math.ceil((this.pausedUntil - Date.now()) / 1000);
      return {
        success: false,
        error: `Rate limited / backoff active. Remaining: ${remainingSec}s`,
      };
    }

    // If we are currently replaying or have a large backlog after being offline, run replayBuffer
    if (this.state === 'replaying' || (this.state === 'offline' && !this.networkDisabled)) {
      return this.replayBuffer(apiUrl, { ...options, fetchFn: fetchImpl });
    }

    const buffered = this.buffer.getBufferedEvents();
    if (buffered.length === 0 && (!options.injectedEvents || options.injectedEvents.length === 0)) {
      return { success: true, acceptedCount: 0 };
    }

    const toSend = [...buffered.slice(0, maxBatch), ...(options.injectedEvents || [])];

    try {
      const res = await fetchImpl(`${apiUrl}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(toSend),
      });

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retrySec = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 5 : 5;
        this.pausedUntil = Date.now() + retrySec * 1000;
        const logMsg = `[429 BACKPRESSURE] ${this.deviceId}: Rate limited by API. Honouring Retry-After: ${retrySec}s`;
        console.warn(logMsg);
        logger.warn({ deviceId: this.deviceId, retrySec }, logMsg);
        return { success: false, status: 429, retryAfterSec: retrySec };
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        this.consecutiveFailures++;
        this.transitionState(
          'offline',
          `HTTP ${res.status}: ${errBody.slice(0, 100) || 'API Error'}`
        );

        // Exponential backoff + full jitter
        const baseDelay = Math.min(30000, 1000 * Math.pow(2, this.consecutiveFailures));
        const jitter = Math.floor(Math.random() * 500);
        this.pausedUntil = Date.now() + baseDelay + jitter;

        logger.warn(
          {
            deviceId: this.deviceId,
            status: res.status,
            backoffMs: baseDelay + jitter,
          },
          'API error, backing off'
        );
        return { success: false, status: res.status, error: errBody };
      }

      // Success 200 OK
      const body = (await res.json()) as {
        results: Array<{
          event_id: string;
          status: 'accepted' | 'duplicate' | 'rejected';
          reason?: string;
        }>;
      };

      const accepted = body.results.filter((r) => r.status === 'accepted').map((r) => r.event_id);
      const duplicate = body.results.filter((r) => r.status === 'duplicate').map((r) => r.event_id);
      const rejected = body.results.filter((r) => r.status === 'rejected').map((r) => r.event_id);

      // Accepted and duplicate are acknowledged by server
      this.buffer.markAcknowledged([...accepted, ...duplicate]);

      // Cache acknowledged events for potential duplicate replays
      for (const ev of toSend) {
        if (accepted.includes(ev.event_id) || duplicate.includes(ev.event_id)) {
          this.ackedEventCache.set(ev.event_id, ev);
        }
      }

      this.consecutiveFailures = 0;
      if (this.state !== 'connected') {
        this.transitionState('connected', 'batch accepted');
      }

      return {
        success: true,
        status: 200,
        acceptedCount: accepted.length,
        duplicateCount: duplicate.length,
        rejectedCount: rejected.length,
      };
    } catch (err: any) {
      this.consecutiveFailures++;
      this.transitionState('offline', `Network failure: ${err.message}`);

      const baseDelay = Math.min(30000, 1000 * Math.pow(2, this.consecutiveFailures));
      const jitter = Math.floor(Math.random() * 500);
      this.pausedUntil = Date.now() + baseDelay + jitter;

      return { success: false, error: err.message };
    }
  }

  public async replayBuffer(
    apiUrl: string,
    options: {
      chunkSize?: number;
      fetchFn?: typeof fetch;
      resendAcked?: boolean;
      shuffleChunks?: boolean;
    } = {}
  ): Promise<SendBatchResult> {
    const fetchImpl = options.fetchFn || fetch;
    const chunkSize = options.chunkSize || 20;
    const resendAcked = options.resendAcked ?? true;
    const shuffleChunks = options.shuffleChunks ?? true;

    const allBuffered = this.buffer.getBufferedEvents();
    if (allBuffered.length === 0) {
      this.transitionState('connected', 'buffer already empty');
      return { success: true, acceptedCount: 0 };
    }

    this.transitionState(
      'replaying',
      `Replaying ${allBuffered.length} events in chunks of ${chunkSize}`
    );

    // Split events into chunks
    const chunks: IngestEvent[][] = [];
    for (let i = 0; i < allBuffered.length; i += chunkSize) {
      chunks.push(allBuffered.slice(i, i + chunkSize));
    }

    // Out-of-order tolerance: shuffle some chunks if multiple chunks exist
    if (shuffleChunks && chunks.length > 1) {
      console.log(
        `[REPLAY SHUFFLE] ${this.deviceId}: Intentionally swapping chunks 0 and 1 to prove out-of-order sequence ingestion tolerance`
      );
      const temp = chunks[0];
      chunks[0] = chunks[1];
      chunks[1] = temp;
    }

    let totalAccepted = 0;
    let totalDuplicate = 0;
    let totalRejected = 0;

    for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
      const chunk = [...chunks[cIdx]];

      // Dedup proof: intentionally resend already-acked events
      if (resendAcked && this.ackedEventCache.size > 0) {
        const dup = this.generateDuplicate();
        if (dup) {
          chunk.push(dup);
          console.log(
            `[REPLAY DEDUP] ${this.deviceId}: Intentionally injecting already-acked event ${dup.event_id} (seq: ${dup.seq}) to prove server deduplication`
          );
        }
      }

      try {
        const res = await fetchImpl(`${apiUrl}/v1/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(chunk),
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          const waitSec = retryAfter ? parseInt(retryAfter, 10) || 5 : 5;
          this.pausedUntil = Date.now() + waitSec * 1000;
          console.warn(
            `[429 BACKPRESSURE] ${this.deviceId} during replay: API rate limited. Pausing for ${waitSec}s`
          );
          return {
            success: false,
            status: 429,
            retryAfterSec: waitSec,
            acceptedCount: totalAccepted,
            duplicateCount: totalDuplicate,
          };
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          this.transitionState('offline', `Replay failed HTTP ${res.status}: ${text.slice(0, 50)}`);
          return {
            success: false,
            status: res.status,
            error: text,
            acceptedCount: totalAccepted,
            duplicateCount: totalDuplicate,
          };
        }

        const body = (await res.json()) as {
          results: Array<{
            event_id: string;
            status: 'accepted' | 'duplicate' | 'rejected';
          }>;
        };

        const accepted = body.results.filter((r) => r.status === 'accepted').map((r) => r.event_id);
        const duplicate = body.results
          .filter((r) => r.status === 'duplicate')
          .map((r) => r.event_id);
        const rejected = body.results.filter((r) => r.status === 'rejected').map((r) => r.event_id);

        this.buffer.markAcknowledged([...accepted, ...duplicate]);
        totalAccepted += accepted.length;
        totalDuplicate += duplicate.length;
        totalRejected += rejected.length;
      } catch (err: any) {
        this.transitionState('offline', `Replay network error: ${err.message}`);
        return {
          success: false,
          error: err.message,
          acceptedCount: totalAccepted,
          duplicateCount: totalDuplicate,
        };
      }
    }

    if (this.buffer.getBufferSize() === 0) {
      this.transitionState(
        'connected',
        `Replay finished (${totalAccepted} accepted, ${totalDuplicate} duplicates proven)`
      );
    }

    return {
      success: true,
      status: 200,
      acceptedCount: totalAccepted,
      duplicateCount: totalDuplicate,
      rejectedCount: totalRejected,
    };
  }
}

export { SimulatedDevice as DeviceAgent };
