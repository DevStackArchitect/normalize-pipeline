import { Pool, PoolClient } from 'pg';
import { query, releaseAdvisoryLock, tryAdvisoryLock } from '../db/client';
import { RunStatus, SourceName } from '../domain/types';
import { validateAndUpsertBatch } from './upsert';

export interface RunLog {
  source: SourceName;
  status: RunStatus;
  upserted: number;
  rejected: number;
  error: string | null;
  startedAt: Date;
}

export interface SyncStore {
  tryLock(source: SourceName): Promise<boolean>;
  unlock(source: SourceName): Promise<void>;
  getCursor(source: SourceName): Promise<string | null>;
  saveCursor(source: SourceName, cursor: string | null): Promise<void>;
  logRun(run: RunLog): Promise<void>;
  upsertBatch(records: unknown[], source: SourceName): Promise<{ upserted: number; rejected: number }>;
}

export async function getCursor(pool: Pool, source: SourceName): Promise<string | null> {
  const result = await query<{ cursor: string | null }>(
    pool,
    'SELECT cursor FROM sync_state WHERE source = $1',
    [source]
  );
  return result.rows[0]?.cursor ?? null;
}

export async function saveCursor(
  pool: Pool,
  source: SourceName,
  cursor: string | null
): Promise<void> {
  await query(
    pool,
    `INSERT INTO sync_state (source, cursor, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [source, cursor]
  );
}

export async function logRun(pool: Pool, run: RunLog): Promise<void> {
  await query(
    pool,
    `INSERT INTO sync_runs (source, started_at, finished_at, status, upserted, rejected, error)
     VALUES ($1, $2, now(), $3, $4, $5, $6)`,
    [run.source, run.startedAt, run.status, run.upserted, run.rejected, run.error]
  );
}

export function createPgSyncStore(pool: Pool): SyncStore {
  const lockClients = new Map<SourceName, PoolClient>();

  return {
    async tryLock(source: SourceName): Promise<boolean> {
      const client = await pool.connect();
      let locked = false;
      try {
        locked = await tryAdvisoryLock(client, source);
      } finally {
        if (!locked) client.release();
      }
      if (locked) lockClients.set(source, client);
      return locked;
    },

    async unlock(source: SourceName): Promise<void> {
      const client = lockClients.get(source);
      if (client === undefined) return;
      lockClients.delete(source);
      try {
        await releaseAdvisoryLock(client, source);
      } finally {
        client.release();
      }
    },

    getCursor: (source) => getCursor(pool, source),
    saveCursor: (source, cursor) => saveCursor(pool, source, cursor),
    logRun: (run) => logRun(pool, run),
    upsertBatch: (records, source) => validateAndUpsertBatch(pool, records, source),
  };
}
