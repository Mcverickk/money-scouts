import 'dotenv/config';
import pg from 'pg';

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
