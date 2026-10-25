import pg from 'pg';

export type ChangeLogEntity = 'event' | 'incident' | 'device' | 'rule' | 'notification';
export type ChangeLogOp = 'INSERT' | 'UPDATE' | 'DELETE';

export interface ChangeLogRecord<T = Record<string, unknown>> {
  entity: ChangeLogEntity;
  entityId: string;
  op: ChangeLogOp;
  data: T;
}

/**
 * Persists an entry to the sequential change_log table and triggers pg_notify
 * for real-time SSE streaming. Can run within an existing transaction client or standalone pool.
 */
export async function emitChangeLog<T = Record<string, unknown>>(
  client: pg.PoolClient | pg.Pool,
  record: ChangeLogRecord<T>
): Promise<number> {
  const res = await client.query<{ seq: string }>(
    `INSERT INTO change_log (entity, entity_id, op, data)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING seq`,
    [record.entity, record.entityId, record.op, JSON.stringify(record.data ?? {})]
  );
  return Number(res?.rows?.[0]?.seq || 0);
}
