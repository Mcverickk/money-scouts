import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pg from 'pg';

// npm workspace scripts run with cwd inside the package, so load the repo-root
// .env explicitly (missing file is fine — hosted envs inject real env vars).
config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

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
