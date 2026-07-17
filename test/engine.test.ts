import { describe, expect, it } from 'vitest';
import {
  FetchResult,
  NormalizedRecord,
  SourceAdapter,
  SourceName,
  StaleCursorError,
} from '../src/domain/types';
import { runSync } from '../src/sync/engine';
import type { RunLog, SyncStore } from '../src/sync/state';

function record(source: SourceName, externalId: string): NormalizedRecord {
  return {
    source,
    externalId,
    entityType: source === 'razorpay' ? 'payment' : source === 'gcal' ? 'event' : 'contact',
    title: 'x',
    amountCents: null,
    currency: null,
    occurredAt: null,
    sourceUpdatedAt: null,
    raw: {},
  };
}

function makeStore(initialCursors: Partial<Record<SourceName, string>> = {}): {
  store: SyncStore;
  calls: string[];
  runs: RunLog[];
  cursors: Map<string, string | null>;
} {
  const cursors = new Map<string, string | null>(Object.entries(initialCursors));
  const calls: string[] = [];
  const runs: RunLog[] = [];
  const store: SyncStore = {
    tryLock: async () => true,
    unlock: async () => undefined,
    getCursor: async (source) => cursors.get(source) ?? null,
    saveCursor: async (source, cursor) => {
      calls.push(`saveCursor:${source}`);
      cursors.set(source, cursor);
    },
    logRun: async (run) => {
      runs.push(run);
    },
    upsertBatch: async (records, source) => {
      calls.push(`upsertBatch:${source}`);
      return { upserted: records.length, rejected: 0 };
    },
  };
  return { store, calls, runs, cursors };
}

function makeAdapter(name: SourceName, overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  const result: FetchResult = {
    records: [record(name, `${name}-1`)],
    nextCursor: `${name}-cursor`,
  };
  return {
    name,
    fetchFull: async () => result,
    fetchIncremental: async () => result,
    mapWebhookPayload: () => [],
    ...overrides,
  };
}

describe('runSync', () => {
  it('falls back to a full fetch when the cursor is stale', async () => {
    const { store, runs } = makeStore({ gcal: 'expired-token' });
    let fullCalled = false;
    const adapter = makeAdapter('gcal', {
      fetchIncremental: async () => {
        throw new StaleCursorError('gcal');
      },
      fetchFull: async () => {
        fullCalled = true;
        return { records: [record('gcal', 'e1')], nextCursor: 'fresh-token' };
      },
    });

    const summaries = await runSync(store, [adapter]);

    expect(fullCalled).toBe(true);
    expect(summaries[0]?.status).toBe('fallback_full');
    expect(summaries[0]?.upserted).toBe(1);
    expect(runs[0]?.status).toBe('fallback_full');
  });

  it('uses fetchFull when no cursor exists and fetchIncremental when one does', async () => {
    const { store, cursors } = makeStore();
    let fullCalls = 0;
    let incrementalCalls = 0;
    const adapter = makeAdapter('hubspot', {
      fetchFull: async () => {
        fullCalls += 1;
        return { records: [], nextCursor: '100' };
      },
      fetchIncremental: async () => {
        incrementalCalls += 1;
        return { records: [], nextCursor: '200' };
      },
    });

    await runSync(store, [adapter]);
    expect(fullCalls).toBe(1);
    expect(incrementalCalls).toBe(0);
    expect(cursors.get('hubspot')).toBe('100');

    await runSync(store, [adapter]);
    expect(fullCalls).toBe(1);
    expect(incrementalCalls).toBe(1);
    expect(cursors.get('hubspot')).toBe('200');
  });

  it('isolates a failing source from healthy ones', async () => {
    const { store, runs } = makeStore();
    const failing = makeAdapter('razorpay', {
      fetchFull: async () => {
        throw new Error('razorpay exploded');
      },
    });

    const summaries = await runSync(store, [makeAdapter('hubspot'), failing, makeAdapter('gcal')]);

    expect(summaries.map((s) => s.status)).toEqual(['ok', 'failed', 'ok']);
    expect(summaries[1]?.error).toContain('razorpay exploded');
    expect(runs.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
  });

  it('saves the cursor only after the upsert resolves', async () => {
    const { store, calls } = makeStore();
    await runSync(store, [makeAdapter('hubspot')]);
    expect(calls).toEqual(['upsertBatch:hubspot', 'saveCursor:hubspot']);
  });

  it('does not save a cursor when the upsert fails', async () => {
    const { store, calls } = makeStore();
    store.upsertBatch = async () => {
      throw new Error('db write failed');
    };
    const summaries = await runSync(store, [makeAdapter('hubspot')]);
    expect(summaries[0]?.status).toBe('failed');
    expect(calls).not.toContain('saveCursor:hubspot');
  });

  it('keeps the previous cursor when nextCursor is null', async () => {
    const { store, cursors, calls } = makeStore({ razorpay: '111' });
    const adapter = makeAdapter('razorpay', {
      fetchIncremental: async () => ({ records: [], nextCursor: null }),
    });
    await runSync(store, [adapter]);
    expect(calls).not.toContain('saveCursor:razorpay');
    expect(cursors.get('razorpay')).toBe('111');
  });

  it('records skipped_locked when the lock is not acquired', async () => {
    const { store, runs } = makeStore();
    store.tryLock = async () => false;
    const summaries = await runSync(store, [makeAdapter('hubspot')]);
    expect(summaries[0]?.status).toBe('skipped_locked');
    expect(runs[0]?.status).toBe('skipped_locked');
  });

  it('clears a corrupted cursor when the fallback full fetch returns no new cursor', async () => {
    const { store, cursors } = makeStore({ hubspot: 'corrupted-cursor' });
    const adapter = makeAdapter('hubspot', {
      fetchIncremental: async () => {
        throw new StaleCursorError('hubspot');
      },
      fetchFull: async () => ({ records: [], nextCursor: null }),
    });
    const summaries = await runSync(store, [adapter]);
    expect(summaries[0]?.status).toBe('fallback_full');
    expect(cursors.get('hubspot')).toBeNull();
  });

  it('logs a failed run when lock acquisition itself throws', async () => {
    const { store, runs } = makeStore();
    store.tryLock = async () => {
      throw new Error('db connection refused');
    };
    const summaries = await runSync(store, [makeAdapter('hubspot')]);
    expect(summaries[0]?.status).toBe('failed');
    expect(summaries[0]?.error).toContain('db connection refused');
    expect(runs[0]?.status).toBe('failed');
  });

  it('always releases the lock, even on failure', async () => {
    const { store } = makeStore();
    const unlocked: string[] = [];
    store.unlock = async (source) => {
      unlocked.push(source);
    };
    const failing = makeAdapter('gcal', {
      fetchFull: async () => {
        throw new Error('boom');
      },
    });
    await runSync(store, [failing]);
    expect(unlocked).toEqual(['gcal']);
  });

  it('runs only the requested source when opts.only is set', async () => {
    const { store, calls } = makeStore();
    await runSync(store, [makeAdapter('hubspot'), makeAdapter('razorpay')], { only: 'razorpay' });
    expect(calls).toEqual(['upsertBatch:razorpay', 'saveCursor:razorpay']);
  });
});
