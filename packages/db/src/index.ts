import pg from 'pg';

// Deliberately NO dotenv here: importing this package must not mutate process.env.
// (orchestratorService.integration.test.ts truncates whatever DATABASE_URL points at
// and relies on the var being unset to skip — an import side effect once defeated
// that guard and wiped the shared Neon DB.) Entrypoints that want .env load it
// themselves: apps/api, apps/ingestor, and migrate.ts all resolve the repo-root path.

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
    }
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export * from './queries.js';
