#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { SimulatedDevice, SimulatedDeviceSpec } from './device-agent.js';
import { ScenarioName, ScenarioRunner } from './scenarios.js';
import { SEED_DEVICES } from '@aps/shared';

const DEFAULT_FLEET: SimulatedDeviceSpec[] = SEED_DEVICES.map((d) => ({
  deviceId: d.id,
  apiKey: d.rawKey,
  name: d.name,
}));

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      devices: { type: 'string', short: 'd' },
      rate: { type: 'string', short: 'r' },
      api: { type: 'string', short: 'a' },
      scenario: { type: 'string', short: 's' },
      'offline-duration': { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const numDevices = values.devices ? parseInt(values.devices, 10) : 5;
  const ratePerSec = values.rate ? parseFloat(values.rate) : 2.0;
  const apiUrl = values.api || process.env.API_URL || 'http://localhost:3000';
  const dataDir = values['data-dir'] || './.simulator-data';
  const offlineDurationSec = values['offline-duration']
    ? parseInt(values['offline-duration'], 10)
    : 120;

  // Determine scenario from flag or first positional argument
  const rawScenario = values.scenario || positionals[0] || 'steady';
  const validScenarios: ScenarioName[] = [
    'steady',
    'offline-reconnect',
    'spike',
    'burst',
    'malformed',
    'duplicate-storm',
    'kill-worker',
  ];

  if (!validScenarios.includes(rawScenario as ScenarioName)) {
    console.error(`Error: Unknown scenario "${rawScenario}".`);
    console.error(`Available scenarios: ${validScenarios.join(', ')}`);
    process.exit(1);
  }

  const scenario = rawScenario as ScenarioName;

  // Initialize fleet specifications
  const fleetSpecs: SimulatedDeviceSpec[] = [];
  for (let i = 0; i < numDevices; i++) {
    if (i < DEFAULT_FLEET.length) {
      fleetSpecs.push({
        ...DEFAULT_FLEET[i],
        dataDir: path.resolve(dataDir),
      });
    } else {
      const idx = i + 1;
      const padId = `dev-${idx.toString().padStart(3, '0')}`;
      fleetSpecs.push({
        deviceId: padId,
        apiKey: `key-${padId}-secret`,
        name: `Dynamic Simulated Device ${idx}`,
        dataDir: path.resolve(dataDir),
      });
    }
  }

  console.log(
    `Initializing ${fleetSpecs.length} simulated devices (persisting buffer in ${dataDir})...`
  );
  const devices = fleetSpecs.map((spec) => new SimulatedDevice(spec));

  const abortController = new AbortController();

  const shutdown = () => {
    console.log(
      '\nGracefully shutting down simulator... All buffered events remain persisted to disk.'
    );
    abortController.abort();
    // Allow active async operations a brief moment to finish
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await ScenarioRunner.run(scenario, {
      devices,
      apiUrl,
      ratePerSec,
      offlineDurationSec,
      signal: abortController.signal,
    });
  } catch (err: any) {
    if (!abortController.signal.aborted) {
      console.error(`Fatal error in scenario [${scenario}]:`, err);
      process.exit(1);
    }
  }
}

function printHelp(): void {
  console.log(`
Real-Time Device Operations Platform - Fleet Simulator CLI

USAGE:
  npm run scenario:<name>
  tsx src/cli.ts [flags]

FLAGS:
  --devices, -d <N>            Number of simulated devices (default: 5)
  --rate, -r <events/sec>      Events generation rate per device (default: 2)
  --api, -a <URL>              API base endpoint URL (default: http://localhost:3000)
  --scenario, -s <name>        Scenario to execute (default: steady)
  --offline-duration <sec>     Offline duration for offline-reconnect scenario (default: 120s)
  --data-dir <path>            Directory for file-backed device buffers (default: ./.simulator-data)
  --help, -h                   Show this help message

AVAILABLE SCENARIOS:
  steady                       Steady telemetry, occasional errors & heartbeats
  offline-reconnect            Device dark for 2 min (buffers to disk), then replays with chunk shuffle & dedup proof
  spike                        Temperature spike (> 80°C) for 30s to test incident deduplication
  burst                        10x rate burst for 30s to demonstrate API backpressure (429 & Retry-After)
  malformed                    Injects invalid/future events to test individual rejection in rejected_events
  duplicate-storm              Emits identical events to prove PostgreSQL ON CONFLICT idempotency
  kill-worker                  Steady telemetry with documented docker commands for manual failover verification

EXAMPLES:
  tsx src/cli.ts --scenario steady --devices 5 --rate 5
  tsx src/cli.ts --scenario spike --api http://localhost:3000
  tsx src/cli.ts --scenario offline-reconnect --offline-duration 30
`);
}

main();
