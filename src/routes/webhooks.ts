import { Router } from 'express';
import { NormalizedRecord, SourceAdapter } from '../domain/types';
import { SyncStore } from '../sync/state';
import { errorMessage } from './sync';

export function webhooksRouter(store: SyncStore, adapters: SourceAdapter[]): Router {
  const router = Router();

  router.post('/webhooks/:source', async (req, res) => {
    const adapter = adapters.find((a) => a.name === req.params.source);
    if (adapter === undefined) {
      res.status(404).json({ error: `unknown source: ${req.params.source}` });
      return;
    }

    let mapped: NormalizedRecord[];
    try {
      mapped = adapter.mapWebhookPayload(req.body);
    } catch (err) {
      res.status(400).json({ error: `unmappable payload: ${errorMessage(err)}` });
      return;
    }

    try {
      const counts = await store.upsertBatch(mapped, adapter.name);
      res.json(counts);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}
