import { Router } from 'express';
import { Pool } from 'pg';
import { SourceAdapter, SourceName } from '../domain/types';
import { runSync } from '../sync/engine';
import { SyncStore } from '../sync/state';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 500 ? parsed : fallback;
}

export function findSource(value: string, adapters: SourceAdapter[]): SourceName | null {
  return adapters.find((adapter) => adapter.name === value)?.name ?? null;
}

export function syncRouter(store: SyncStore, adapters: SourceAdapter[], pool: Pool): Router {
  const router = Router();

  router.post('/sync', async (_req, res) => {
    try {
      const runs = await runSync(store, adapters);
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.post('/sync/:source', async (req, res) => {
    const source = findSource(req.params.source, adapters);
    if (source === null) {
      res.status(404).json({ error: `unknown source: ${req.params.source}` });
      return;
    }
    try {
      const runs = await runSync(store, adapters, { only: source });
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get('/sync/runs', async (req, res) => {
    try {
      const limit = parseLimit(req.query.limit, 20);
      const result = await pool.query('SELECT * FROM sync_runs ORDER BY id DESC LIMIT $1', [limit]);
      res.json({ runs: result.rows });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}
