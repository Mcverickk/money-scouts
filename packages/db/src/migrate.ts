// Applies packages/db/migrations/*.sql in filename order, once each.
// Run with: npm run db:migrate (needs DATABASE_URL).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './index.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rowCount } = await client.query('select 1 from schema_migrations where name = $1', [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
    console.log('migrations up to date');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
