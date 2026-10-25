import { createDbPool, createLogger, runMigrations, runSeed } from '@aps/shared';
import { loadApiConfig } from './config.js';
import { buildServer } from './server.js';

const logger = createLogger({ service: 'api-main' });

async function main() {
  const config = loadApiConfig();
  const pool = createDbPool({ connectionString: config.DATABASE_URL });

  // Automatically apply database migrations and seed default records
  if (process.env.AUTO_MIGRATE !== 'false') {
    try {
      logger.info('Checking and applying database migrations...');
      await runMigrations();
      await runSeed();
    } catch (migErr) {
      logger.error({ err: migErr }, 'Database migration/seed encountered an error');
      // If we cannot connect to DB during startup, we still let API start so /readyz can report 503
    }
  }

  const app = buildServer(config, pool);

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API server gracefully...');
    try {
      await app.close();
      await pool.end();
      logger.info('API server and DB pool closed.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(
      { port: config.PORT, host: config.HOST },
      `APS API server listening on http://${config.HOST}:${config.PORT}`
    );
  } catch (err) {
    logger.error({ err }, 'Failed to start API server');
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMain) {
  main();
}
