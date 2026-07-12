import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import Fastify from 'fastify';

// npm workspace scripts run with cwd inside the package; load the repo-root .env
// explicitly (missing file is fine — hosted envs inject real env vars). Env-dependent
// modules (@edge-desk/db) self-load it too; everything else reads env lazily.
config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });
import { getPool } from '@edge-desk/db';
import { eventsRoutes } from './routes/events.js';
import { marketsRoutes } from './routes/markets.js';
import { marketChecksRoutes } from './routes/marketChecks.js';
import { replaysRoutes } from './routes/replays.js';

const app = Fastify({ logger: true });

// Neon's first connection (TLS + possible cold resume) can exceed 1s; keep the
// timeout generous enough that a cold pool doesn't read as an outage.
const HEALTH_DB_TIMEOUT_MS = 5000;

/** `select 1` with a short timeout — health must answer even when the DB is down. */
async function dbIsUp(): Promise<boolean> {
  try {
    await Promise.race([
      getPool().query('select 1'),
      new Promise((_resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('health db check timed out')),
          HEALTH_DB_TIMEOUT_MS,
        );
        t.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

app.get('/health', async () => {
  const up = await dbIsUp();
  return { status: up ? 'ok' : 'degraded', db: up ? 'up' : 'down' };
});

await app.register(eventsRoutes);
await app.register(marketsRoutes);
await app.register(marketChecksRoutes);
await app.register(replaysRoutes);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
