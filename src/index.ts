import { createAdapters } from './adapters';
import { createApp } from './app';
import { Config, loadConfig } from './config';
import { createPool } from './db/client';
import { logger } from './logger';
import { createPgSyncStore } from './sync/state';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const pool = createPool(config.DATABASE_URL);
  await pool.query('SELECT 1');
  logger.info('database connection verified');

  const adapters = createAdapters(config);
  const store = createPgSyncStore(pool);
  const app = createApp({ pool, adapters, store, debugSecret: config.DEBUG_SECRET });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'server listening');
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      pool
        .end()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
