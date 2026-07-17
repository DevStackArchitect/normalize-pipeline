import { Router } from 'express';
import { SourceAdapter } from '../domain/types';
import { SyncStore } from '../sync/state';
import { errorMessage, findSource } from './sync';

export function debugRouter(
  store: SyncStore,
  adapters: SourceAdapter[],
  debugSecret: string
): Router {
  const router = Router();

  router.post('/debug/corrupt-cursor/:source', async (req, res) => {
    if (req.get('x-debug-secret') !== debugSecret) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const source = findSource(req.params.source, adapters);
    if (source === null) {
      res.status(404).json({ error: `unknown source: ${req.params.source}` });
      return;
    }
    try {
      await store.saveCursor(source, 'corrupted-cursor');
      res.json({ ok: true, source, cursor: 'corrupted-cursor' });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}
