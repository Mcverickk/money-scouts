import type { MarketSnapshot, NormalizedEvent } from '@edge-desk/contracts';
import { getPool } from '@edge-desk/db';
import type pg from 'pg';
import {
  createHermesOrchestratorFromEnv,
  HermesOrchestrator,
  type HermesOrchestrationInput,
  type HermesOrchestrationResult,
  type OrchestrationEvidence,
  type OrchestrationOutcome,
  type PriorAlertSummary,
} from './orchestrator.js';

const STEP_NAME = 'hermes_orchestration';

export interface OrchestratorWorkerOptions {
  pool?: pg.Pool;
  orchestrator?: HermesOrchestrator;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  logger?: Pick<Console, 'info' | 'error'>;
}

/**
 * Claims queued agent runs and processes them one at a time in this worker process.
 * Multiple worker processes are safe: PostgreSQL row locks prevent double claims.
 */
export async function runOrchestratorWorker(options: OrchestratorWorkerOptions = {}): Promise<void> {
  const pool = options.pool ?? getPool();
  const orchestrator = options.orchestrator ?? createHermesOrchestratorFromEnv();
  const pollIntervalMs = options.pollIntervalMs ?? envPositiveInteger('ORCHESTRATOR_POLL_INTERVAL_MS', 1_000);
  const logger = options.logger ?? console;

  await orchestrator.assertReady();
  logger.info('Hermes orchestrator worker started');
  while (!options.signal?.aborted) {
    const runId = await claimNextQueuedRun(pool);
    if (!runId) {
      await abortableDelay(pollIntervalMs, options.signal);
      continue;
    }

    try {
      const result = await processAgentRun(pool, orchestrator, runId);
      logger.info(
        `Hermes orchestration completed for run ${runId} as ${result.category} (${result.hermesRunId})`,
      );
    } catch (error) {
      logger.error(`Hermes orchestration failed for run ${runId}: ${errorMessage(error)}`);
    }
  }
  logger.info('Hermes orchestrator worker stopped');
}

export async function claimNextQueuedRun(pool: pg.Pool): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const selected = await client.query<{ id: string }>(
      `select id::text
         from agent_runs
        where status = 'queued'
        order by started_at, id
        for update skip locked
        limit 1`,
    );
    const runId = selected.rows[0]?.id;
    if (!runId) {
      await client.query('commit');
      return undefined;
    }

    await client.query(
      `update agent_runs
          set status = 'running', started_at = now(), error_code = null, error_message = null
        where id = $1`,
      [runId],
    );
    await client.query('commit');
    return runId;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function processAgentRun(
  pool: pg.Pool,
  orchestrator: HermesOrchestrator,
  runId: string,
): Promise<HermesOrchestrationResult> {
  const input = await loadOrchestrationInput(pool, runId);
  const stepId = await createRunStep(pool, runId);

  try {
    const result = await orchestrator.analyze(input);
    await persistSuccess(pool, runId, stepId, input, result);
    return result;
  } catch (error) {
    await persistFailure(pool, runId, stepId, error);
    throw error;
  }
}

export async function loadOrchestrationInput(
  pool: pg.Pool,
  runId: string,
): Promise<HermesOrchestrationInput> {
  const runResult = await pool.query<RunContextRow>(
    `select ar.id::text as run_id,
            e.id::text as event_id,
            e.source,
            e.source_event_id,
            e.event_type,
            e.event_text,
            e.source_url,
            e.payload,
            e.occurred_at,
            m.id::text as market_db_id,
            m.polymarket_market_id,
            m.category
       from agent_runs ar
       join events e on e.id = ar.event_id
       join markets m on m.id = ar.market_id
      where ar.id = $1`,
    [runId],
  );
  const row = runResult.rows[0];
  if (!row) throw new Error(`agent run ${runId} was not found or has no event`);

  const [evidenceResult, outcomesResult, alertsResult] = await Promise.all([
    pool.query<EvidenceRow>(
      `select id::text,
              title,
              url,
              excerpt,
              published_at,
              retrieved_at,
              source_tier,
              relevance,
              confidence
         from evidence
        where event_id = $1
        order by relevance desc nulls last, retrieved_at`,
      [row.event_id],
    ),
    pool.query<OutcomeRow>(
      `select mo.id::text as outcome_id,
              mo.name,
              mo.token_id,
              baseline.yes_price as baseline_yes_price,
              baseline.best_bid as baseline_best_bid,
              baseline.best_ask as baseline_best_ask,
              baseline.spread_bps as baseline_spread_bps,
              baseline.depth_usd as baseline_depth_usd,
              baseline.observed_at as baseline_observed_at,
              current.yes_price as current_yes_price,
              current.best_bid as current_best_bid,
              current.best_ask as current_best_ask,
              current.spread_bps as current_spread_bps,
              current.depth_usd as current_depth_usd,
              current.observed_at as current_observed_at
         from market_outcomes mo
         left join lateral (
           select * from market_snapshots ms
            where ms.outcome_id = mo.id and ms.observed_at < $2
            order by ms.observed_at desc limit 1
         ) baseline on true
         left join lateral (
           select * from market_snapshots ms
            where ms.outcome_id = mo.id and ms.observed_at > $2
            order by ms.observed_at desc limit 1
         ) current on true
        where mo.market_id = $1
        order by mo.name`,
      [row.market_db_id, row.occurred_at],
    ),
    pool.query<PriorAlertRow>(
      `select d.side,
              a.sent_at,
              d.confidence,
              d.lag_bps
         from alerts a
         join decisions d on d.id = a.decision_id
        where a.market_id = $1 and a.status = 'sent'
        order by a.sent_at desc
        limit 10`,
      [row.market_db_id],
    ),
  ]);

  const event: NormalizedEvent = {
    sourceEventId: row.source_event_id,
    source: row.source,
    marketId: row.polymarket_market_id,
    category: parseCategory(row.category),
    eventType: row.event_type ?? 'unknown',
    eventText: row.event_text ?? '',
    occurredAt: row.occurred_at.toISOString(),
    sourceUrl: row.source_url ?? undefined,
    data: jsonObjectOrUndefined(row.payload),
  };

  return {
    runId,
    event,
    evidence: evidenceResult.rows.map(mapEvidence),
    outcomes: outcomesResult.rows.map((outcome) => mapOutcome(row.polymarket_market_id, outcome)),
    priorAlerts: alertsResult.rows.map(mapPriorAlert),
  };
}

async function createRunStep(pool: pg.Pool, runId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into run_steps (run_id, name, agent_role, status, attempt)
     select $1, $2, 'manager', 'running', coalesce(max(attempt), 0) + 1
       from run_steps
      where run_id = $1 and name = $2
     returning id::text`,
    [runId, STEP_NAME],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`failed to create orchestration step for run ${runId}`);
  return id;
}

async function persistSuccess(
  pool: pg.Pool,
  runId: string,
  stepId: string,
  input: HermesOrchestrationInput,
  result: HermesOrchestrationResult,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update run_steps
          set status = 'completed',
              output = $2,
              source_refs = $3,
              completed_at = now(),
              latency_ms = $4,
              model = $5,
              input_tokens = $6,
              output_tokens = $7
        where id = $1`,
      [
        stepId,
        JSON.stringify(result),
        JSON.stringify(
          input.evidence.map((item) => ({ id: item.id, label: item.title, url: item.url })),
        ),
        result.latencyMs,
        result.model ?? null,
        result.usage?.inputTokens ?? null,
        result.usage?.outputTokens ?? null,
      ],
    );
    await client.query(
      `update agent_runs
          set hermes_task_id = $2,
              specialist = $3,
              model = $4,
              input_tokens = $5,
              output_tokens = $6,
              latency_ms = $7,
              error_code = null,
              error_message = null
        where id = $1`,
      [
        runId,
        result.hermesRunId,
        result.category,
        result.model ?? null,
        result.usage?.inputTokens ?? null,
        result.usage?.outputTokens ?? null,
        result.latencyMs,
      ],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function persistFailure(
  pool: pg.Pool,
  runId: string,
  stepId: string,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error).slice(0, 4_000);
  const code = error instanceof Error ? error.name : 'UnknownError';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update run_steps
          set status = 'failed', completed_at = now(), error_code = $2, error_message = $3
        where id = $1`,
      [stepId, code, message],
    );
    await client.query(
      `update agent_runs
          set status = 'failed', completed_at = now(), error_code = $2, error_message = $3
        where id = $1`,
      [runId, code, message],
    );
    await client.query('commit');
  } catch (persistError) {
    await client.query('rollback');
    throw new AggregateError([error, persistError], 'orchestration and failure persistence both failed');
  } finally {
    client.release();
  }
}

interface RunContextRow {
  run_id: string;
  event_id: string;
  source: string;
  source_event_id: string;
  event_type: string | null;
  event_text: string | null;
  source_url: string | null;
  payload: unknown;
  occurred_at: Date;
  market_db_id: string;
  polymarket_market_id: string;
  category: string;
}

interface EvidenceRow {
  id: string;
  title: string | null;
  url: string | null;
  excerpt: string | null;
  published_at: Date | null;
  retrieved_at: Date;
  source_tier: string | null;
  relevance: number | null;
  confidence: number | null;
}

interface OutcomeRow {
  outcome_id: string;
  name: string;
  token_id: string;
  baseline_yes_price: string | null;
  baseline_best_bid: string | null;
  baseline_best_ask: string | null;
  baseline_spread_bps: number | null;
  baseline_depth_usd: string | null;
  baseline_observed_at: Date | null;
  current_yes_price: string | null;
  current_best_bid: string | null;
  current_best_ask: string | null;
  current_spread_bps: number | null;
  current_depth_usd: string | null;
  current_observed_at: Date | null;
}

interface PriorAlertRow {
  side: string | null;
  sent_at: Date | null;
  confidence: number | null;
  lag_bps: number | null;
}

function mapEvidence(row: EvidenceRow): OrchestrationEvidence {
  return {
    id: row.id,
    title: row.title ?? 'Untitled evidence',
    url: row.url ?? undefined,
    excerpt: row.excerpt ?? undefined,
    publishedAt: row.published_at?.toISOString(),
    retrievedAt: row.retrieved_at.toISOString(),
    sourceTier: row.source_tier ?? undefined,
    relevance: nullableNumber(row.relevance),
    confidence: nullableNumber(row.confidence),
  };
}

function mapOutcome(marketId: string, row: OutcomeRow): OrchestrationOutcome {
  return {
    outcomeId: row.outcome_id,
    name: row.name,
    tokenId: row.token_id,
    baseline: mapSnapshot(marketId, row, 'baseline'),
    current: mapSnapshot(marketId, row, 'current'),
  };
}

function mapSnapshot(
  marketId: string,
  row: OutcomeRow,
  prefix: 'baseline' | 'current',
): MarketSnapshot | undefined {
  const observedAt = row[`${prefix}_observed_at`];
  const yesPrice = numeric(row[`${prefix}_yes_price`]);
  if (!observedAt || yesPrice === undefined) return undefined;

  return {
    marketId,
    outcome: row.name,
    tokenId: row.token_id,
    yesPrice,
    bestBid: numeric(row[`${prefix}_best_bid`]) ?? yesPrice,
    bestAsk: numeric(row[`${prefix}_best_ask`]) ?? yesPrice,
    spreadBps: row[`${prefix}_spread_bps`] ?? 0,
    depthUsd: numeric(row[`${prefix}_depth_usd`]) ?? 0,
    observedAt: observedAt.toISOString(),
  };
}

function mapPriorAlert(row: PriorAlertRow): PriorAlertSummary {
  return {
    side: row.side ?? 'unknown',
    sentAt: row.sent_at?.toISOString() ?? '',
    confidence: nullableNumber(row.confidence) ?? 0,
    lagBps: row.lag_bps ?? 0,
  };
}

function parseCategory(value: string): NormalizedEvent['category'] {
  if (value === 'sports' || value === 'geopolitics' || value === 'crypto') return value;
  throw new Error(`unsupported market category ${value}`);
}

function jsonObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nullableNumber(value: number | null): number | undefined {
  return value === null || !Number.isFinite(value) ? undefined : value;
}

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
