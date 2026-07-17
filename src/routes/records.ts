import { Router } from 'express';
import { Pool } from 'pg';
import { errorMessage, parseLimit } from './sync';

export function recordsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/records', async (req, res) => {
    try {
      const conditions: string[] = [];
      const params: Array<string | number> = [];
      if (typeof req.query.source === 'string' && req.query.source !== '') {
        params.push(req.query.source);
        conditions.push(`source = $${params.length}`);
      }
      if (typeof req.query.entity_type === 'string' && req.query.entity_type !== '') {
        params.push(req.query.entity_type);
        conditions.push(`entity_type = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const totals = await pool.query<{ total: string }>(
        `SELECT count(*) AS total FROM records ${where}`,
        params
      );
      const limit = parseLimit(req.query.limit, 50);
      const rows = await pool.query(
        `SELECT * FROM records ${where} ORDER BY synced_at DESC, id DESC LIMIT $${params.length + 1}`,
        [...params, limit]
      );
      res.json({ total: Number(totals.rows[0]?.total ?? 0), records: rows.rows });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  return router;
}
