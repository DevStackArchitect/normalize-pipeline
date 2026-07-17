import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from './client';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const pool = createPool(databaseUrl);
  try {
    await pool.query(sql);
    console.log('schema applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
