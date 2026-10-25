import { createDbPool, createLogger } from '@aps/shared';
import { loadWorkerConfig } from './config.js';
import { QueueWorker } from './queue-worker.js';
import { AbsenceMonitor } from './absence-monitor.js';
import { OutboxWorker } from './outbox-worker.js';

const logger = createLogger({ service: 'worker-main' });

async function main() {
  const config = loadWorkerConfig();
  const pool = createDbPool({ connectionString: config.DATABASE_URL });

  logger.info('Initializing APS Worker services...');

  const queueWorker = new QueueWorker(pool, config);
  const absenceMonitor = new AbsenceMonitor(pool, config);
  const outboxWorker = new OutboxWorker(pool, config);

  queueWorker.start();
  absenceMonitor.start();
  outboxWorker.start();

  logger.info('All worker background engines started.');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Stopping worker background engines gracefully...');
    await queueWorker.stop();
    absenceMonitor.stop();
    outboxWorker.stop();

    try {
      await pool.end();
      logger.info('Database pool closed. Worker shutdown complete.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain =
  process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMain) {
  main().catch((err) => {
    logger.error({ err }, 'Worker fatal startup error');
    process.exit(1);
  });
}
