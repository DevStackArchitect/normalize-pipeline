import {
  FetchResult,
  RunStatus,
  RunSummary,
  SourceAdapter,
  SourceName,
  StaleCursorError,
} from '../domain/types';
import { logger } from '../logger';
import { SyncStore } from './state';

export async function runSync(
  store: SyncStore,
  adapters: SourceAdapter[],
  opts: { only?: SourceName } = {}
): Promise<RunSummary[]> {
  const selected = opts.only ? adapters.filter((a) => a.name === opts.only) : adapters;
  const summaries: RunSummary[] = [];
  for (const adapter of selected) {
    let summary: RunSummary;
    try {
      summary = await syncOne(store, adapter);
    } catch (err) {
      summary = {
        source: adapter.name,
        status: 'failed',
        upserted: 0,
        rejected: 0,
        durationMs: 0,
        error: errorMessage(err),
      };
      logger.error({ source: adapter.name, err }, 'sync run crashed outside the adapter');
    }
    summaries.push(summary);
  }
  return summaries;
}

async function syncOne(store: SyncStore, adapter: SourceAdapter): Promise<RunSummary> {
  const source = adapter.name;
  const startedAt = new Date();
  logger.info({ source }, 'sync run started');

  let locked = false;
  try {
    locked = await store.tryLock(source);
  } catch (err) {
    logger.error({ source, err }, 'failed to acquire source lock');
    return finishRun(store, source, startedAt, 'failed', 0, 0, errorMessage(err));
  }
  if (!locked) {
    logger.warn({ source }, 'sync skipped, lock not acquired');
    return finishRun(store, source, startedAt, 'skipped_locked', 0, 0, null);
  }

  let status: RunStatus = 'ok';
  let upserted = 0;
  let rejected = 0;
  let error: string | null = null;
  try {
    const cursor = await store.getCursor(source);
    let result: FetchResult;
    if (cursor === null) {
      result = await adapter.fetchFull();
    } else {
      try {
        result = await adapter.fetchIncremental(cursor);
      } catch (err) {
        if (!(err instanceof StaleCursorError)) throw err;
        logger.warn({ source }, 'stale cursor rejected by source, falling back to full fetch');
        status = 'fallback_full';
        result = await adapter.fetchFull();
      }
    }

    const counts = await store.upsertBatch(result.records, source);
    upserted = counts.upserted;
    rejected = counts.rejected;

    if (result.nextCursor !== null || status === 'fallback_full') {
      await store.saveCursor(source, result.nextCursor);
    }
  } catch (err) {
    status = 'failed';
    error = errorMessage(err);
    logger.error({ source, err }, 'sync run failed');
  } finally {
    try {
      await store.unlock(source);
    } catch (err) {
      logger.error({ err, source }, 'failed to release source lock');
    }
  }

  return finishRun(store, source, startedAt, status, upserted, rejected, error);
}

async function finishRun(
  store: SyncStore,
  source: SourceName,
  startedAt: Date,
  status: RunStatus,
  upserted: number,
  rejected: number,
  error: string | null
): Promise<RunSummary> {
  const durationMs = Date.now() - startedAt.getTime();
  try {
    await store.logRun({ source, status, upserted, rejected, error, startedAt });
  } catch (err) {
    logger.error({ err, source }, 'failed to record sync run');
  }
  logger.info({ source, status, upserted, rejected, durationMs }, 'sync run finished');
  return { source, status, upserted, rejected, durationMs, error };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
