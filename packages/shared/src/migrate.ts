import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbPool, withTransaction } from './db.js';
import { createLogger } from './logger.js';

const logger = createLogger({ service: 'migrator' });

export async function runMigrations(migrationsDir?: string): Promise<void> {
  const pool = createDbPool();

  try {
    const dir =
      migrationsDir || process.env.MIGRATIONS_DIR || path.resolve(process.cwd(), 'migrations');

    logger.info({ dir }, 'Starting database migrations...');

    if (!fs.existsSync(dir)) {
      throw new Error(`Migrations directory not found at: ${dir}`);
    }

    // Acquire advisory lock to prevent concurrent migrations
    await pool.query('SELECT pg_advisory_lock(987654321);');

    try {
      // Ensure schema_migrations table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Fetch applied migrations
      const res = await pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version ASC'
      );
      const applied = new Set(res.rows.map((r) => r.version));

      // Read and sort migration files
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        if (applied.has(file)) {
          logger.debug({ file }, 'Migration already applied, skipping.');
          continue;
        }

        const filePath = path.join(dir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        logger.info({ file }, 'Applying migration...');

        await withTransaction(pool, async (client) => {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        });

        logger.info({ file }, 'Successfully applied migration.');
      }

      logger.info('All migrations completed successfully.');
    } finally {
      await pool.query('SELECT pg_advisory_unlock(987654321);');
    }
  } finally {
    await pool.end();
  }
}

// Allow direct execution
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (isMain) {
  runMigrations().catch((err) => {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  });
}
