import fs from 'node:fs';
import path from 'node:path';
import { IngestEvent } from '@aps/shared';

export interface DevicePersistedState {
  deviceId: string;
  lastSeq: number;
  buffer: IngestEvent[];
  acknowledgedIds: string[];
}

export class FileBackedBuffer {
  public readonly deviceId: string;
  public readonly dataDir: string;
  public readonly filePath: string;
  private state: DevicePersistedState;

  constructor(deviceId: string, dataDir: string = './.simulator-data') {
    this.deviceId = deviceId;
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, `${encodeURIComponent(deviceId)}.json`);

    this.state = {
      deviceId,
      lastSeq: 0,
      buffer: [],
      acknowledgedIds: [],
    };

    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  public load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<DevicePersistedState>;
        this.state = {
          deviceId: this.deviceId,
          lastSeq: typeof parsed.lastSeq === 'number' ? parsed.lastSeq : 0,
          buffer: Array.isArray(parsed.buffer) ? parsed.buffer : [],
          acknowledgedIds: Array.isArray(parsed.acknowledgedIds) ? parsed.acknowledgedIds : [],
        };
      }
    } catch {
      // If reading corrupted/unreadable file, fallback to empty buffer and preserve existing seq if possible
    }
  }

  public save(): void {
    this.ensureDir();
    const tmpPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 6)}`;
    const serialized = JSON.stringify(this.state, null, 2);
    try {
      fs.writeFileSync(tmpPath, serialized, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Fallback direct write if atomic rename fails on some Windows setups
      try {
        fs.writeFileSync(this.filePath, serialized, 'utf-8');
      } catch {
        // Ignored
      }
    }
  }

  public nextSeq(): number {
    this.state.lastSeq += 1;
    this.save();
    return this.state.lastSeq;
  }

  public getLastSeq(): number {
    return this.state.lastSeq;
  }

  public append(event: IngestEvent): void {
    this.state.buffer.push(event);
    if (event.seq > this.state.lastSeq) {
      this.state.lastSeq = event.seq;
    }
    this.save();
  }

  public appendBatch(events: IngestEvent[]): void {
    for (const ev of events) {
      this.state.buffer.push(ev);
      if (ev.seq > this.state.lastSeq) {
        this.state.lastSeq = ev.seq;
      }
    }
    this.save();
  }

  public getBufferedEvents(): IngestEvent[] {
    return [...this.state.buffer];
  }

  public getBufferSize(): number {
    return this.state.buffer.length;
  }

  public getAcknowledgedIds(): string[] {
    return [...this.state.acknowledgedIds];
  }

  public markAcknowledged(eventIds: string[]): void {
    if (eventIds.length === 0) return;
    const idSet = new Set(eventIds);

    // Filter out acknowledged events from the pending buffer
    this.state.buffer = this.state.buffer.filter((e) => !idSet.has(e.event_id));

    // Append to acknowledgedIds ring-buffer (capped at 50)
    for (const id of eventIds) {
      if (!this.state.acknowledgedIds.includes(id)) {
        this.state.acknowledgedIds.push(id);
      }
    }
    if (this.state.acknowledgedIds.length > 50) {
      this.state.acknowledgedIds = this.state.acknowledgedIds.slice(-50);
    }

    this.save();
  }

  public clear(): void {
    this.state.buffer = [];
    this.state.acknowledgedIds = [];
    this.save();
  }

  public destroy(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      // Ignored
    }
  }
}
