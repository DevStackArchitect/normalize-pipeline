import express, { Express, NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { SourceAdapter } from './domain/types';
import { getStatusCode } from './lib/retry';
import { logger } from './logger';
import { debugRouter } from './routes/debug';
import { healthRouter } from './routes/health';
import { recordsRouter } from './routes/records';
import { syncRouter } from './routes/sync';
import { webhooksRouter } from './routes/webhooks';
import { SyncStore } from './sync/state';

export interface AppDeps {
  pool: Pool;
  adapters: SourceAdapter[];
  store: SyncStore;
  debugSecret: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Date.now() - start,
        },
        'request'
      );
    });
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter(deps.pool));
  app.use(syncRouter(deps.store, deps.adapters, deps.pool));
  app.use(recordsRouter(deps.pool));
  app.use(webhooksRouter(deps.store, deps.adapters));
  app.use(debugRouter(deps.store, deps.adapters, deps.debugSecret));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled request error');
    const status = getStatusCode(err) ?? 500;
    res
      .status(status >= 400 && status < 600 ? status : 500)
      .json({ error: err instanceof Error ? err.message : 'internal error' });
  });

  return app;
}
