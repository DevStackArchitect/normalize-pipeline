import { Pool } from 'pg';
import { validateRecord } from '../domain/recordSchema';
import { NormalizedRecord, SourceName } from '../domain/types';
import { logger } from '../logger';

export const UPSERT_SQL = `
INSERT INTO records
  (source, external_id, entity_type, title, amount_cents, currency, occurred_at, source_updated_at, raw, synced_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
ON CONFLICT (source, external_id) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  title = EXCLUDED.title,
  amount_cents = EXCLUDED.amount_cents,
  currency = EXCLUDED.currency,
  occurred_at = EXCLUDED.occurred_at,
  source_updated_at = EXCLUDED.source_updated_at,
  raw = EXCLUDED.raw,
  synced_at = now()
`;

const CHUNK_SIZE = 100;

export async function validateAndUpsertBatch(
  pool: Pool,
  records: unknown[],
  source: SourceName
): Promise<{ upserted: number; rejected: number }> {
  const valid: NormalizedRecord[] = [];
  let rejected = 0;

  for (const input of records) {
    const result = validateRecord(input);
    if (result.ok) {
      valid.push(result.record);
    } else {
      rejected += 1;
      await quarantine(pool, source, input, result.reason);
    }
  }

  for (let offset = 0; offset < valid.length; offset += CHUNK_SIZE) {
    const chunk = valid.slice(offset, offset + CHUNK_SIZE);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of chunk) {
        await client.query(UPSERT_SQL, [
          record.source,
          record.externalId,
          record.entityType,
          record.title,
          record.amountCents,
          record.currency,
          record.occurredAt,
          record.sourceUpdatedAt,
          toJson(record.raw),
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken, nothing to roll back */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return { upserted: valid.length, rejected };
}

async function quarantine(
  pool: Pool,
  source: SourceName,
  raw: unknown,
  reason: string
): Promise<void> {
  logger.warn({ source, reason }, 'record rejected');
  try {
    await pool.query(
      'INSERT INTO rejected_records (source, raw, reason) VALUES ($1, $2::jsonb, $3)',
      [source, toJson(raw), reason]
    );
  } catch (err) {
    logger.error({ err, source }, 'failed to persist rejected record');
  }
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}
