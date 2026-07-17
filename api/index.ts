import { createAdapters } from '../src/adapters';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db/client';
import { createPgSyncStore } from '../src/sync/state';

// Vercel serverless entry point. The module scope runs once per cold start
// and is reused across warm invocations, so the pool and adapters persist
// for the life of the instance. src/index.ts remains the long-running
// server entry for local dev and Render.
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const store = createPgSyncStore(pool);

const app = createApp({
  pool,
  adapters: createAdapters(config),
  store,
  debugSecret: config.DEBUG_SECRET,
});

export default app;
