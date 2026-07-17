import { describe, expect, it } from 'vitest';
import { validateRecord } from '../src/domain/recordSchema';
import { Pool } from 'pg';
import { UPSERT_SQL, validateAndUpsertBatch } from '../src/sync/upsert';
import { makeFakePool } from './helpers';

const validRecord = {
  source: 'razorpay',
  externalId: 'pay_123',
  entityType: 'payment',
  title: 'Payment pay_123',
  amountCents: 1250,
  currency: 'USD',
  occurredAt: new Date('2026-01-01T00:00:00Z'),
  sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
  raw: { id: 'pay_123' },
};

describe('validateRecord', () => {
  it('accepts a valid record', () => {
    const result = validateRecord(validRecord);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.externalId).toBe('pay_123');
      expect(result.record.raw).toEqual({ id: 'pay_123' });
    }
  });

  it('accepts nulls for all nullable fields', () => {
    const result = validateRecord({
      ...validRecord,
      title: null,
      amountCents: null,
      currency: null,
      occurredAt: null,
      sourceUpdatedAt: null,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an empty externalId', () => {
    const result = validateRecord({ ...validRecord, externalId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('externalId');
  });

  it('rejects a negative amountCents', () => {
    const result = validateRecord({ ...validRecord, amountCents: -1 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer amountCents', () => {
    const result = validateRecord({ ...validRecord, amountCents: 12.5 });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid Date instance', () => {
    const result = validateRecord({ ...validRecord, occurredAt: new Date('not a date') });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown source', () => {
    const result = validateRecord({ ...validRecord, source: 'salesforce' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    expect(validateRecord('garbage').ok).toBe(false);
    expect(validateRecord(null).ok).toBe(false);
    expect(validateRecord(42).ok).toBe(false);
  });
});

describe('validateAndUpsertBatch', () => {
  it('quarantines invalid records and never throws', async () => {
    const { pool, captured } = makeFakePool();
    const batch = [
      validRecord,
      { ...validRecord, externalId: 'pay_456' },
      { ...validRecord, externalId: '' },
    ];
    const result = await validateAndUpsertBatch(pool, batch, 'razorpay');
    expect(result).toEqual({ upserted: 2, rejected: 1 });

    const rejectedInserts = captured.filter((q) => q.text.includes('rejected_records'));
    expect(rejectedInserts).toHaveLength(1);
    expect(rejectedInserts[0]?.params[2]).toContain('externalId');

    const recordWrites = captured.filter((q) => q.text.includes('INSERT INTO records'));
    expect(recordWrites).toHaveLength(2);
  });

  it('still counts rejections when persisting the rejection row fails', async () => {
    const { pool } = makeFakePool();
    const failingPool = {
      ...pool,
      query: async (): Promise<never> => {
        throw new Error('db down for rejected_records');
      },
      connect: (pool as unknown as { connect: unknown }).connect,
    } as unknown as Pool;
    const result = await validateAndUpsertBatch(failingPool, [{ ...validRecord, externalId: '' }], 'razorpay');
    expect(result).toEqual({ upserted: 0, rejected: 1 });
  });

  it('wraps each chunk in a transaction', async () => {
    const { pool, captured } = makeFakePool();
    await validateAndUpsertBatch(pool, [validRecord], 'razorpay');
    const texts = captured.map((q) => q.text);
    expect(texts).toContain('BEGIN');
    expect(texts).toContain('COMMIT');
  });

  it('is idempotent: the same batch twice yields the same row count', async () => {
    if (!process.env.DATABASE_URL_TEST) {
      expect(UPSERT_SQL).toContain('ON CONFLICT (source, external_id) DO UPDATE');
      return;
    }
    const { createPool } = await import('../src/db/client');
    const { readFileSync } = await import('node:fs');
    const realPool = createPool(process.env.DATABASE_URL_TEST);
    try {
      await realPool.query(readFileSync('src/db/schema.sql', 'utf8'));
      await realPool.query(
        "DELETE FROM records WHERE source = 'razorpay' AND external_id LIKE 'idem_test_%'"
      );
      const batch = [
        { ...validRecord, externalId: 'idem_test_1' },
        { ...validRecord, externalId: 'idem_test_2' },
      ];
      await validateAndUpsertBatch(realPool, batch, 'razorpay');
      await validateAndUpsertBatch(realPool, batch, 'razorpay');
      const counts = await realPool.query<{ count: string }>(
        "SELECT count(*) AS count FROM records WHERE source = 'razorpay' AND external_id LIKE 'idem_test_%'"
      );
      expect(Number(counts.rows[0]?.count)).toBe(2);
    } finally {
      await realPool.end();
    }
  });
});
