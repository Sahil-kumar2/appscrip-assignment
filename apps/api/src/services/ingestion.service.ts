import pg from 'pg';
import {
  IngestEventSchema,
  IngestEventResult,
  isDeviceTimestampValid,
  emitChangeLog,
} from '@aps/shared';
import { eventsIngestedCounter } from '../metrics.js';

export interface AuthenticatedDeviceRecord {
  id: string;
  location_id: string;
  status: string;
  last_seq: number;
  last_event_ts: Date | null;
  key_hash: string;
}

export interface IngestionBatchOutcome {
  results: IngestEventResult[];
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  maxSeqReceived: number;
  maxEventTs: Date | null;
}

export class IngestionService {
  private readonly lateEventWindowSeconds: number;

  constructor(lateEventWindowSeconds: number = 300) {
    this.lateEventWindowSeconds = lateEventWindowSeconds;
  }

  /**
   * Validates structural batch requirements (JSON array, length 1..500)
   */
  public validateRawBatch(rawBatch: unknown): { error?: string; batch?: unknown[] } {
    if (!Array.isArray(rawBatch)) {
      return { error: 'Invalid batch payload: request body must be a JSON array of events' };
    }
    if (rawBatch.length === 0) {
      return { error: 'Invalid batch payload: batch must contain at least 1 event' };
    }
    if (rawBatch.length > 500) {
      return {
        error: `Invalid batch payload: batch size (${rawBatch.length}) exceeds maximum limit of 500`,
      };
    }
    return { batch: rawBatch };
  }

  /**
   * Ingests an authenticated batch of events inside an active client transaction.
   * Enforces schema conformance, intra-batch deduplication, future-timestamp limits,
   * idempotency via primary key constraints, and device status updates.
   */
  public async ingestBatch(
    client: pg.PoolClient,
    device: AuthenticatedDeviceRecord,
    rawBatch: unknown[],
    now: Date = new Date()
  ): Promise<IngestionBatchOutcome> {
    const results: IngestEventResult[] = [];
    const batchSeenIds = new Set<string>();

    let maxSeqReceived = Number(device.last_seq);
    let maxEventTs: Date | null = device.last_event_ts ? new Date(device.last_event_ts) : null;
    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;

    for (const rawItem of rawBatch) {
      // 1. Individual schema validation with Zod
      const parsed = IngestEventSchema.safeParse(rawItem);
      if (!parsed.success) {
        const reason = `Validation error: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`;
        const eventId =
          rawItem && typeof (rawItem as any).event_id === 'string'
            ? (rawItem as any).event_id
            : '00000000-0000-0000-0000-000000000000';

        await client.query(
          `INSERT INTO rejected_events (device_id, raw_payload, reason)
           VALUES ($1, $2::jsonb, $3)`,
          [device.id, JSON.stringify(rawItem ?? null), reason]
        );

        eventsIngestedCounter.inc({ status: 'rejected' });
        results.push({ event_id: eventId, status: 'rejected', reason });
        rejectedCount++;
        continue;
      }

      const ev = parsed.data;

      // 2. Reject mismatched device_id in event payload
      if (ev.device_id !== device.id) {
        const reason = `Device ID in event payload (${ev.device_id}) does not match authenticated device (${device.id})`;
        await client.query(
          `INSERT INTO rejected_events (device_id, raw_payload, reason)
           VALUES ($1, $2::jsonb, $3)`,
          [device.id, JSON.stringify(rawItem), reason]
        );

        eventsIngestedCounter.inc({ status: 'rejected' });
        results.push({ event_id: ev.event_id, status: 'rejected', reason });
        rejectedCount++;
        continue;
      }

      // 3. Clock skew verification (reject timestamp > 5 minutes in future)
      const timeValid = isDeviceTimestampValid(ev.ts, 5, now);
      if (!timeValid.valid) {
        const reason = timeValid.reason || 'Timestamp too far in future';
        await client.query(
          `INSERT INTO rejected_events (device_id, raw_payload, reason)
           VALUES ($1, $2::jsonb, $3)`,
          [device.id, JSON.stringify(rawItem), reason]
        );

        eventsIngestedCounter.inc({ status: 'rejected' });
        results.push({ event_id: ev.event_id, status: 'rejected', reason });
        rejectedCount++;
        continue;
      }

      // 4. Intra-batch duplicate check
      if (batchSeenIds.has(ev.event_id)) {
        eventsIngestedCounter.inc({ status: 'duplicate' });
        results.push({
          event_id: ev.event_id,
          status: 'duplicate',
          reason: 'Duplicate event_id within batch',
        });
        duplicateCount++;
        continue;
      }
      batchSeenIds.add(ev.event_id);

      // 5. Lateness check
      const eventDate = new Date(ev.ts);
      const isLate = now.getTime() - eventDate.getTime() > this.lateEventWindowSeconds * 1000;

      // 6. Idempotent insertion: UNIQUE(device_id, event_id)
      const insertRes = await client.query<{ event_id: string }>(
        `INSERT INTO events (
           event_id, device_id, seq, ts, received_at, type, payload,
           schema_version, processing_status, attempts, is_late
         )
         VALUES ($1, $2, $3, $4, NOW(), $5, $6::jsonb, $7, 'pending', 0, $8)
         ON CONFLICT (device_id, event_id) DO NOTHING
         RETURNING event_id`,
        [
          ev.event_id,
          ev.device_id,
          ev.seq,
          ev.ts,
          ev.type,
          JSON.stringify(ev.payload),
          ev.schema_version,
          isLate,
        ]
      );

      if (insertRes.rows.length > 0) {
        // Newly accepted event
        eventsIngestedCounter.inc({ status: 'accepted' });
        results.push({ event_id: ev.event_id, status: 'accepted' });
        acceptedCount++;

        if (ev.seq > maxSeqReceived) {
          maxSeqReceived = ev.seq;
        }
        if (!maxEventTs || eventDate > maxEventTs) {
          maxEventTs = eventDate;
        }

        // Record change_log record per accepted event
        await emitChangeLog(client, {
          entity: 'event',
          entityId: ev.event_id,
          op: 'INSERT',
          data: {
            event_id: ev.event_id,
            device_id: ev.device_id,
            seq: ev.seq,
            type: ev.type,
            ts: ev.ts,
            is_late: isLate,
          },
        });
      } else {
        // Duplicate event across batches
        eventsIngestedCounter.inc({ status: 'duplicate' });
        results.push({
          event_id: ev.event_id,
          status: 'duplicate',
          reason: 'Event already accepted for device',
        });
        duplicateCount++;
      }
    }

    // 7. Update device telemetry metadata
    await client.query(
      `UPDATE devices
       SET last_seen_at = NOW(),
           last_event_ts = CASE 
             WHEN $1::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_event_ts, '1970-01-01'::timestamptz), $1::timestamptz)
             ELSE last_event_ts
           END,
           last_seq = GREATEST(last_seq, $2),
           status = 'online'
       WHERE id = $3`,
      [maxEventTs ? maxEventTs.toISOString() : null, maxSeqReceived, device.id]
    );

    // 8. Record device status change if transitioning to online
    if (device.status !== 'online') {
      await emitChangeLog(client, {
        entity: 'device',
        entityId: device.id,
        op: 'UPDATE',
        data: {
          device_id: device.id,
          from_status: device.status,
          to_status: 'online',
        },
      });
    }

    return {
      results,
      acceptedCount,
      duplicateCount,
      rejectedCount,
      maxSeqReceived,
      maxEventTs,
    };
  }
}
