import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export type QueryParam = string | number | boolean | Date | null;

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

export async function query<R extends QueryResultRow>(
  pool: Pool,
  text: string,
  params: QueryParam[] = []
): Promise<QueryResult<R>> {
  return pool.query<R>(text, params);
}

export async function tryAdvisoryLock(client: PoolClient, source: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    [`sync:${source}`]
  );
  return result.rows[0]?.locked === true;
}

export async function releaseAdvisoryLock(client: PoolClient, source: string): Promise<void> {
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`sync:${source}`]);
}
