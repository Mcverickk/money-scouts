// Ingestor — the always-on half of the ingestion leg (docs/TECH_ARCHITECTURE.md §4.4,
// docs/POLYMARKET_INTEGRATION.md): CLOB-WS snapshot recorder (baseline supply) plus the
// Sports-WS goal watcher (event trigger -> POST /v1/events -> Linkup corroboration).
// Re-reads the watched-market set every minute so newly registered markets are picked up
// without a restart.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// npm workspace scripts run with cwd inside the package; load the repo-root .env
// explicitly (missing file is fine — hosted envs inject real env vars).
config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env') });

const { listActiveWatchedMarkets, getPool } = await import('@edge-desk/db');
const { startSnapshotRecorder } = await import('./snapshotRecorder.js');
const { startGoalWatcher } = await import('./goalWatcher.js');

const REFRESH_INTERVAL_MS = 60_000;

let stopRecorder: () => void = () => {};
let stopWatcher: () => void = () => {};
let watchedFingerprint = '';

async function syncWatchedMarkets(): Promise<void> {
  const watched = await listActiveWatchedMarkets();
  const fingerprint = watched
    .map((m) => `${m.id}:${m.game_slug ?? ''}:${m.outcomes.map((o) => o.token_id).sort().join(',')}`)
    .sort()
    .join('|');
  if (fingerprint === watchedFingerprint) return;
  watchedFingerprint = fingerprint;

  console.log(`[ingestor] watched set changed — (re)subscribing to ${watched.length} market(s)`);
  stopRecorder();
  stopWatcher();
  stopRecorder = startSnapshotRecorder(watched);
  stopWatcher = startGoalWatcher(watched);
}

await syncWatchedMarkets();
const refreshTimer = setInterval(() => {
  syncWatchedMarkets().catch((err) => console.error('[ingestor] refresh failed', err));
}, REFRESH_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  console.log(`[ingestor] ${signal} — shutting down`);
  clearInterval(refreshTimer);
  stopRecorder();
  stopWatcher();
  await getPool().end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
