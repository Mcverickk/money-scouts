import 'dotenv/config';
import { getPool } from '@edge-desk/db';
import { HermesTelegramClient } from '@edge-desk/integrations';
import { runAlertSenderWorker } from './alertSender.js';
import { runMatcherWorker } from './matcher.js';
import { createHermesOrchestratorFromEnv } from './orchestrator.js';
import { runOrchestratorWorker } from './orchestratorService.js';

const abortController = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => abortController.abort());
}

const roles = new Set(
  (process.env.WORKER_ROLES ?? 'orchestrator')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean),
);

const pool = getPool();
const workers: Array<Promise<void>> = [];

if (roles.has('orchestrator')) {
  workers.push(
    runOrchestratorWorker({
      pool,
      orchestrator: createHermesOrchestratorFromEnv(),
      signal: abortController.signal,
    }),
  );
}
if (roles.has('alert_sender')) {
  workers.push(
    runAlertSenderWorker({
      pool,
      sender: HermesTelegramClient.fromEnv(),
      signal: abortController.signal,
    }),
  );
}
if (roles.has('matcher')) {
  workers.push(
    runMatcherWorker({
      pool,
      signal: abortController.signal,
    }),
  );
}

if (workers.length === 0) {
  console.log('edge-desk workers: no implemented worker role selected');
} else {
  await Promise.all(workers);
  await pool.end();
}
