import { createLogger, SEED_DEVICES } from '@aps/shared';
import { loadSimulatorConfig } from './config.js';
import { SimulatedDevice, SimulatedDeviceSpec } from './device-agent.js';
import { ScenarioName, ScenarioRunner } from './scenarios.js';

export * from './buffer.js';
export * from './device-agent.js';
export * from './scenarios.js';
export * from './config.js';

const logger = createLogger({ service: 'simulator' });

export class FleetSimulator {
  private isRunning = false;
  private abortController: AbortController | null = null;
  private readonly config = loadSimulatorConfig();
  private readonly devices: SimulatedDevice[];

  constructor(customDevices?: SimulatedDeviceSpec[]) {
    const specs =
      customDevices ||
      SEED_DEVICES.map((d) => ({
        deviceId: d.id,
        apiKey: d.rawKey,
        name: d.name,
      }));

    this.devices = specs.map((spec) => new SimulatedDevice(spec));
  }

  public getDevices(): SimulatedDevice[] {
    return this.devices;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    logger.info(
      { fleetSize: this.devices.length, apiUrl: this.config.API_URL },
      'Starting Device Fleet Simulator'
    );

    const scenario = (process.env.SCENARIO as ScenarioName) || 'steady';
    const rate = Math.max(1, Math.floor(1000 / this.config.INTERVAL_MS));

    try {
      await ScenarioRunner.run(scenario, {
        devices: this.devices,
        apiUrl: this.config.API_URL,
        ratePerSec: rate,
        signal: this.abortController.signal,
      });
    } catch (err: any) {
      if (!this.abortController?.signal.aborted) {
        logger.error({ err }, 'Error during simulator execution');
      }
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    logger.info('Fleet Simulator stopped');
  }
}

async function main() {
  const simulator = new FleetSimulator();
  simulator.start();

  const shutdown = () => {
    simulator.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isMain =
  process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMain) {
  main();
}
