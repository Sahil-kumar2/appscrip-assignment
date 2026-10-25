import { SimulatedDevice } from './device-agent.js';
import { createLogger } from '@aps/shared';

const logger = createLogger({ service: 'scenarios' });

export type ScenarioName =
  | 'steady'
  | 'offline-reconnect'
  | 'spike'
  | 'burst'
  | 'malformed'
  | 'duplicate-storm'
  | 'kill-worker';

export interface ScenarioContext {
  devices: SimulatedDevice[];
  apiUrl: string;
  ratePerSec: number;
  offlineDurationSec?: number;
  warmupSec?: number;
  signal?: AbortSignal;
}

export class ScenarioRunner {
  public static async run(scenario: ScenarioName, ctx: ScenarioContext): Promise<void> {
    console.log(
      `\n================================================================================`
    );
    console.log(`>>> STARTING SCENARIO: [${scenario.toUpperCase()}]`);
    console.log(
      `>>> Fleet size: ${ctx.devices.length} devices | API: ${ctx.apiUrl} | Base Rate: ${ctx.ratePerSec} events/sec`
    );
    console.log(
      `================================================================================\n`
    );

    switch (scenario) {
      case 'steady':
        return this.runSteady(ctx);
      case 'offline-reconnect':
        return this.runOfflineReconnect(ctx);
      case 'spike':
        return this.runSpike(ctx);
      case 'burst':
        return this.runBurst(ctx);
      case 'malformed':
        return this.runMalformed(ctx);
      case 'duplicate-storm':
        return this.runDuplicateStorm(ctx);
      case 'kill-worker':
        return this.runKillWorker(ctx);
      default:
        throw new Error(`Unknown scenario: ${scenario}`);
    }
  }

  /**
   * Scenario: STEADY
   * Normal telemetry (temperature normal ± noise), occasional errors, periodic heartbeats.
   */
  public static async runSteady(ctx: ScenarioContext): Promise<void> {
    const intervalMs = Math.max(100, Math.floor(1000 / ctx.ratePerSec));
    let tick = 0;

    while (!ctx.signal?.aborted) {
      tick++;
      for (const dev of ctx.devices) {
        if (tick % 10 === 0) {
          dev.generateHeartbeat();
        } else if (tick % 25 === 0) {
          dev.generateError('ERR_TRANSDUCER_DRIFT', 'Sensor transducer output drifted by 0.8%');
        } else {
          dev.generateTelemetry(22.0, 2.0);
        }

        const res = await dev.transmitBatch(ctx.apiUrl);
        if (res.success && (res.acceptedCount || res.duplicateCount || res.rejectedCount)) {
          logger.info(
            {
              device: dev.deviceId,
              accepted: res.acceptedCount,
              duplicate: res.duplicateCount,
              rejected: res.rejectedCount,
            },
            `[Steady] Sent batch for ${dev.deviceId}`
          );
        }
      }

      await sleep(intervalMs, ctx.signal);
    }
  }

  /**
   * Scenario: OFFLINE-RECONNECT
   * Device runs normally, goes dark for N seconds (buffers to disk), then reconnects
   * and replays buffered backlog in chunks with chunk shuffling and duplicate injection.
   */
  public static async runOfflineReconnect(ctx: ScenarioContext): Promise<void> {
    const offlineSec = ctx.offlineDurationSec || 120;
    const warmupSec = ctx.warmupSec ?? 10;
    const intervalMs = Math.max(100, Math.floor(1000 / ctx.ratePerSec));

    if (warmupSec > 0) {
      console.log(
        `[Scenario: offline-reconnect] Step 1: Emitting normal telemetry for ${warmupSec}s...`
      );
      const initialEndTime = Date.now() + warmupSec * 1000;
      while (Date.now() < initialEndTime && !ctx.signal?.aborted) {
        for (const dev of ctx.devices) {
          dev.generateTelemetry();
          await dev.transmitBatch(ctx.apiUrl);
        }
        await sleep(intervalMs, ctx.signal);
      }
    }

    console.log(
      `\n================================================================================`
    );
    console.log(`[Scenario: offline-reconnect] Step 2: Going OFFLINE for ${offlineSec} seconds!`);
    console.log(
      `Devices will accumulate events into local file-backed buffers without network transmission.`
    );
    console.log(
      `================================================================================\n`
    );

    for (const dev of ctx.devices) {
      dev.setNetworkDisabled(true);
    }

    const offlineEndTime = Date.now() + offlineSec * 1000;
    let offlineTicks = 0;

    while (Date.now() < offlineEndTime && !ctx.signal?.aborted) {
      offlineTicks++;
      for (const dev of ctx.devices) {
        if (offlineTicks % 5 === 0) {
          dev.generateHeartbeat();
        } else {
          dev.generateTelemetry();
        }
      }

      if (offlineTicks % 5 === 0) {
        const remaining = Math.max(0, Math.ceil((offlineEndTime - Date.now()) / 1000));
        console.log(
          `[Offline Simulation] ${remaining}s remaining... Buffer sizes: ${ctx.devices.map((d) => `${d.deviceId}:${d.buffer.getBufferSize()}`).join(', ')}`
        );
      }

      await sleep(intervalMs, ctx.signal);
    }

    console.log(
      `\n================================================================================`
    );
    console.log(
      `[Scenario: offline-reconnect] Step 3: Network RESTORED! Replaying buffered events...`
    );
    console.log(`Replaying in chunks with chunk shuffling and intentional duplicate injection.`);
    console.log(
      `================================================================================\n`
    );

    for (const dev of ctx.devices) {
      dev.setNetworkDisabled(false);
      const replayRes = await dev.replayBuffer(ctx.apiUrl, {
        chunkSize: 20,
        resendAcked: true,
        shuffleChunks: true,
      });

      console.log(
        `[Replay Summary] ${dev.deviceId}: ${replayRes.acceptedCount} accepted, ${replayRes.duplicateCount} duplicates proven, remaining in buffer: ${dev.buffer.getBufferSize()}`
      );
    }

    console.log(
      `\n>>> [Scenario: offline-reconnect] Completed successfully! Resuming steady state.\n`
    );
    return this.runSteady(ctx);
  }

  /**
   * Scenario: SPIKE
   * Normal temperature for 10s, then sustained temperature spike (> 80°C) for 30s
   * to verify rule evaluation, incident creation, and dedup occurrence increments.
   */
  public static async runSpike(ctx: ScenarioContext): Promise<void> {
    const intervalMs = Math.max(100, Math.floor(1000 / ctx.ratePerSec));
    const warmupSec = ctx.warmupSec ?? 8;

    if (warmupSec > 0) {
      console.log(`[Scenario: spike] Step 1: Normal temperature for ${warmupSec} seconds...`);
      const t1End = Date.now() + warmupSec * 1000;
      while (Date.now() < t1End && !ctx.signal?.aborted) {
        for (const dev of ctx.devices) {
          dev.generateTelemetry(22.0, 1.0);
          await dev.transmitBatch(ctx.apiUrl);
        }
        await sleep(intervalMs, ctx.signal);
      }
    }

    console.log(
      `\n================================================================================`
    );
    console.log(`[Scenario: spike] Step 2: INITIATING TEMPERATURE SPIKE (> 80°C) for 30 seconds!`);
    console.log(
      `Target: Trigger 'rule-temp-high' threshold rule and verify incident dedup occurrence bumping.`
    );
    console.log(
      `================================================================================\n`
    );

    const spikeEndTime = Date.now() + 30000;
    while (Date.now() < spikeEndTime && !ctx.signal?.aborted) {
      for (const dev of ctx.devices) {
        // Temperature well above 80°C threshold
        const spikeTemp = +(88.0 + Math.random() * 8.0).toFixed(1);
        dev.generateSpike(spikeTemp);
        const res = await dev.transmitBatch(ctx.apiUrl);
        if (res.success) {
          console.log(
            `[Spike Emitted] ${dev.deviceId} temp=${spikeTemp}°C (Accepted: ${res.acceptedCount})`
          );
        }
      }
      await sleep(intervalMs, ctx.signal);
    }

    console.log(
      `\n>>> [Scenario: spike] Temperature returning to normal (22°C). Resuming steady state.\n`
    );
    return this.runSteady(ctx);
  }

  /**
   * Scenario: BURST
   * Normal rate for 5s, then 10x generation rate for 30s to trigger API backpressure (429).
   */
  public static async runBurst(ctx: ScenarioContext): Promise<void> {
    console.log(`[Scenario: burst] Step 1: Steady rate for 5 seconds...`);
    const initialEndTime = Date.now() + 5000;
    const baseInterval = Math.max(200, Math.floor(1000 / ctx.ratePerSec));

    while (Date.now() < initialEndTime && !ctx.signal?.aborted) {
      for (const dev of ctx.devices) {
        dev.generateTelemetry();
        await dev.transmitBatch(ctx.apiUrl);
      }
      await sleep(baseInterval, ctx.signal);
    }

    console.log(
      `\n================================================================================`
    );
    console.log(`[Scenario: burst] Step 2: TRIGGERING 10x BURST RATE for 30 seconds!`);
    console.log(
      `Objective: Exceed API pending depth threshold to demonstrate 429 Too Many Requests & Retry-After.`
    );
    console.log(
      `================================================================================\n`
    );

    const burstEndTime = Date.now() + 30000;
    let burstCount = 0;

    while (Date.now() < burstEndTime && !ctx.signal?.aborted) {
      burstCount++;
      for (const dev of ctx.devices) {
        // Generate a large batch per device (up to 30 events per tick)
        for (let i = 0; i < 20; i++) {
          dev.generateTelemetry();
        }

        const res = await dev.transmitBatch(ctx.apiUrl, { maxBatchSize: 100 });
        if (res.status === 429) {
          console.warn(
            `[429 DEMO] ${dev.deviceId}: Backpressure detected! API returned 429. Retry-After: ${res.retryAfterSec}s`
          );
        } else if (res.success) {
          console.log(
            `[Burst Sent] ${dev.deviceId}: ${res.acceptedCount} events accepted into queue.`
          );
        }
      }

      await sleep(50, ctx.signal);
    }

    console.log(`\n>>> [Scenario: burst] Burst phase completed. Resuming steady state.\n`);
    return this.runSteady(ctx);
  }

  /**
   * Scenario: MALFORMED
   * Injects bad events (future ts, invalid schema, malformed UUID) alongside valid events
   * to prove per-event rejection in rejected_events without failing whole batches.
   */
  public static async runMalformed(ctx: ScenarioContext): Promise<void> {
    console.log(
      `\n================================================================================`
    );
    console.log(
      `[Scenario: malformed] Injecting malformed & future events alongside valid telemetry.`
    );
    console.log(`Objective: Demonstrate individual rejection and storage in rejected_events.`);
    console.log(
      `================================================================================\n`
    );

    let iteration = 0;
    while (iteration < 10 && !ctx.signal?.aborted) {
      iteration++;
      for (const dev of ctx.devices) {
        // Valid event
        dev.generateTelemetry();

        // Injected malformed event
        const badEvent = dev.generateMalformed();

        const res = await dev.transmitBatch(ctx.apiUrl, {
          injectedEvents: [badEvent],
        });

        console.log(
          `[Malformed Test] ${dev.deviceId} Batch Result: Accepted: ${res.acceptedCount ?? 0}, Rejected: ${res.rejectedCount ?? 0}`
        );
      }
      await sleep(1500, ctx.signal);
    }

    console.log(`\n>>> [Scenario: malformed] Malformed test completed. Resuming steady state.\n`);
    return this.runSteady(ctx);
  }

  /**
   * Scenario: DUPLICATE-STORM
   * Emits high volume of duplicate events (re-transmitting the same event_id and seq).
   */
  public static async runDuplicateStorm(ctx: ScenarioContext): Promise<void> {
    console.log(
      `\n================================================================================`
    );
    console.log(`[Scenario: duplicate-storm] Transmitting duplicate event payloads.`);
    console.log(
      `Objective: Prove PostgreSQL ON CONFLICT DO NOTHING idempotency under high duplicate load.`
    );
    console.log(
      `================================================================================\n`
    );

    // First generate and send valid events
    for (const dev of ctx.devices) {
      dev.generateTelemetry();
      await dev.transmitBatch(ctx.apiUrl);
    }

    let rounds = 0;
    while (rounds < 15 && !ctx.signal?.aborted) {
      rounds++;
      for (const dev of ctx.devices) {
        // Generate duplicate of previously acknowledged event
        const dup = dev.generateDuplicate();
        if (dup) {
          const res = await dev.transmitBatch(ctx.apiUrl, {
            injectedEvents: [dup, { ...dup }],
          });
          console.log(
            `[Duplicate Storm] ${dev.deviceId}: Sent duplicate ${dup.event_id}. Response: ${res.duplicateCount} duplicates acknowledged.`
          );
        } else {
          dev.generateTelemetry();
          await dev.transmitBatch(ctx.apiUrl);
        }
      }
      await sleep(1000, ctx.signal);
    }

    console.log(`\n>>> [Scenario: duplicate-storm] Completed. Resuming steady state.\n`);
    return this.runSteady(ctx);
  }

  /**
   * Scenario: KILL-WORKER
   * Continuous steady transmission with clear live instructions for manual worker failover testing.
   */
  public static async runKillWorker(ctx: ScenarioContext): Promise<void> {
    console.log(`
================================================================================
[SCENARIO: kill-worker] Worker Failover & Queue Durability Test
================================================================================
The simulator is actively pumping events into the APS API queue.

MANUAL VERIFICATION STEPS:

1. In another terminal, stop the background worker:
   $ docker compose stop worker

2. Observe queue accumulation:
   - Events are accepted by API (200 OK) and committed to PostgreSQL queue.
   - Pending queue depth rises. Check via:
     * API: curl http://localhost:3000/readyz
     * Web Dashboard: http://localhost:5173 (Ops Tab -> Queue Depth & Lag)

3. Restart the background worker:
   $ docker compose start worker

4. Observe automatic recovery:
   - Worker immediately claims pending rows with SELECT FOR UPDATE SKIP LOCKED.
   - Pending count drains back to 0.
   - Rules are evaluated and incidents/notifications are processed with zero data loss!
================================================================================
`);

    return this.runSteady(ctx);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
