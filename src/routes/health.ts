import { Router } from 'express';
import { Pool } from 'pg';

export function healthRouter(pool: Pool): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'database unreachable' });
    }
  });

  return router;
}
