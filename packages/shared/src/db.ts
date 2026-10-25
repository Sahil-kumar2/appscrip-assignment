import pg from 'pg';

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export function createDbPool(config?: DbConfig): pg.Pool {
  const connectionString =
    config?.connectionString ||
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/aps';

  const pool = new Pool({
    connectionString,
    max: config?.max ?? Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 5000,
  });

  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
