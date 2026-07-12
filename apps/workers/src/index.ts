import 'dotenv/config';
import { getPool } from '@edge-desk/db';
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

if (!roles.has('orchestrator')) {
  console.log('edge-desk workers: no implemented worker role selected');
} else {
  await runOrchestratorWorker({
    pool: getPool(),
    orchestrator: createHermesOrchestratorFromEnv(),
    signal: abortController.signal,
  });
  await getPool().end();
}
