import type { MatcherAction, Side, SpecialistSignal } from '@edge-desk/contracts';
import { getPool } from '@edge-desk/db';
import {
  evaluateLag,
  SCORING_POLICY_VERSION,
  type LagResult,
  type LagThresholds,
} from '@edge-desk/scoring';
import type pg from 'pg';

const MATCHER_STEP = 'deterministic_matcher';

export interface MatcherWorkerOptions {
  pool?: pg.Pool;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'info' | 'error'>;
}

interface ClaimedMatcherRun {
  runId: string;
  stepId: string;
}

interface MatcherContext {
  runId: string;
  marketId: string;
  marketTitle: string;
  eventOccurredAt: Date;
  outcomeId: string;
  outcomeName: string;
  tokenId: string;
  signal: SpecialistSignal;
  baselineSnapshotId?: string;
  baselinePrice?: number;
  baselineObservedAt?: Date;
  currentSnapshotId?: string;
  currentPrice?: number;
  currentObservedAt?: Date;
  spreadBps: number;
  depthUsd: number;
  evidenceAgeSeconds: number;
  evidence: Array<{ id: string; title: string; url?: string }>;
  thresholds: LagThresholds & { cooldownMinutes: number };
  inCooldown: boolean;
}

export async function runMatcherWorker(options: MatcherWorkerOptions = {}): Promise<void> {
  const pool = options.pool ?? getPool();
  const pollIntervalMs =
    options.pollIntervalMs ?? envPositiveInteger('MATCHER_POLL_INTERVAL_MS', 1_000, options.env);
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;

  logger.info('Deterministic matcher worker started');
  while (!options.signal?.aborted) {
    const claimed = await claimNextMatcherRun(pool);
    if (!claimed) {
      await abortableDelay(pollIntervalMs, options.signal);
      continue;
    }
    try {
      const result = await processMatcherRun(pool, claimed, env);
      logger.info(`Matcher ${result.action} decision completed for run ${claimed.runId}`);
    } catch (error) {
      await persistMatcherFailure(pool, claimed, error);
      logger.error(`Matcher failed for run ${claimed.runId}: ${errorMessage(error)}`);
    }
  }
  logger.info('Deterministic matcher worker stopped');
}

export async function claimNextMatcherRun(pool: pg.Pool): Promise<ClaimedMatcherRun | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const selected = await client.query<{ id: string }>(
      `select ar.id::text
         from agent_runs ar
        where ar.status = 'running'
          and exists (
            select 1 from run_steps hs
             where hs.run_id = ar.id
               and hs.name = 'hermes_orchestration'
               and hs.status = 'completed'
          )
          and not exists (select 1 from decisions d where d.run_id = ar.id)
          and not exists (
            select 1 from run_steps ms
             where ms.run_id = ar.id
               and ms.name = $1
               and ms.status in ('running', 'completed')
          )
        order by ar.started_at, ar.id
        for update of ar skip locked
        limit 1`,
      [MATCHER_STEP],
    );
    const runId = selected.rows[0]?.id;
    if (!runId) {
      await client.query('commit');
      return undefined;
    }

    const step = await client.query<{ id: string }>(
      `insert into run_steps (run_id, name, agent_role, status, attempt)
       select $1, $2, 'matcher', 'running', coalesce(max(attempt), 0) + 1
         from run_steps
        where run_id = $1 and name = $2
       returning id::text`,
      [runId, MATCHER_STEP],
    );
    await client.query('commit');
    return { runId, stepId: step.rows[0]!.id };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function processMatcherRun(
  pool: pg.Pool,
  claimed: ClaimedMatcherRun,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ action: MatcherAction; decisionId: string; alertId?: string }> {
  const context = await loadMatcherContext(pool, claimed.runId);
  const lag = evaluateContext(context);
  const action = lag.action;
  const side: Side = context.signal.direction === 'yes_up' ? 'buy_yes' : 'buy_no';
  const riskFlags = unique([...context.signal.riskFlags, ...lag.failedGates]);
  const reason = context.signal.summary;
  const client = await pool.connect();

  try {
    await client.query('begin');
    const decision = await client.query<{ id: string }>(
      `insert into decisions (
         run_id, market_id, outcome_id, action, side, confidence,
         expected_move_bps, observed_move_bps, lag_bps, reason, risk_flags,
         baseline_snapshot_id, current_snapshot_id, scoring_policy_version
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id::text`,
      [
        context.runId,
        context.marketId,
        context.outcomeId,
        action,
        side,
        context.signal.confidence,
        context.signal.expectedMoveBps,
        lag.observedMoveBps,
        lag.lagBps,
        reason,
        riskFlags,
        context.baselineSnapshotId ?? null,
        context.currentSnapshotId ?? null,
        SCORING_POLICY_VERSION,
      ],
    );
    const decisionId = decision.rows[0]!.id;
    let alertId: string | undefined;

    if (action === 'notify') {
      const destination = requiredEnv(env, 'TELEGRAM_ALERT_CHAT_ID');
      const message = composeTelegramAlert(context, side, lag, claimed.runId);
      const alert = await client.query<{ id: string }>(
        `insert into alerts (decision_id, run_id, market_id, message, status)
         values ($1,$2,$3,$4,'pending') returning id::text`,
        [decisionId, context.runId, context.marketId, message],
      );
      alertId = alert.rows[0]!.id;
      await client.query(
        `insert into delivery_outbox (
           alert_id, channel, destination, idempotency_key, status
         ) values ($1, 'telegram', $2, $3, 'pending')`,
        [alertId, destination, `telegram:${decisionId}:${destination}`],
      );
    }

    await client.query(
      `update run_steps
          set status = 'completed', output = $2, completed_at = now()
        where id = $1`,
      [
        claimed.stepId,
        JSON.stringify({ ...lag, action, side, riskFlags, decisionId, alertId }),
      ],
    );
    await client.query(
      `update agent_runs set status = 'completed', completed_at = now() where id = $1`,
      [context.runId],
    );
    await client.query('commit');
    return { action, decisionId, alertId };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function loadMatcherContext(pool: pg.Pool, runId: string): Promise<MatcherContext> {
  const orchestration = await pool.query<{
    output: unknown;
    market_id: string;
    market_title: string;
    thresholds: unknown;
    occurred_at: Date;
  }>(
    `select hs.output,
            m.id::text as market_id,
            m.title as market_title,
            m.thresholds,
            e.occurred_at
       from agent_runs ar
       join markets m on m.id = ar.market_id
       join events e on e.id = ar.event_id
       join run_steps hs on hs.run_id = ar.id
      where ar.id = $1
        and hs.name = 'hermes_orchestration'
        and hs.status = 'completed'
      order by hs.attempt desc
      limit 1`,
    [runId],
  );
  const base = orchestration.rows[0];
  if (!base) throw new Error(`completed Hermes orchestration not found for run ${runId}`);
  const output = object(base.output, 'Hermes orchestration output');
  const signal = parseStoredSignal(output.signal);
  const tokenId = string(output.selectedOutcomeTokenId, 'selectedOutcomeTokenId');
  const thresholds = parseThresholds(base.thresholds);

  const market = await pool.query<SnapshotContextRow>(
    `select mo.id::text as outcome_id,
            mo.name as outcome_name,
            mo.token_id,
            baseline.id::text as baseline_snapshot_id,
            baseline.yes_price as baseline_price,
            baseline.observed_at as baseline_observed_at,
            current.id::text as current_snapshot_id,
            current.yes_price as current_price,
            current.observed_at as current_observed_at,
            current.spread_bps,
            current.depth_usd
       from market_outcomes mo
       left join lateral (
         select * from market_snapshots ms
          where ms.outcome_id = mo.id and ms.observed_at < $3
          order by ms.observed_at desc limit 1
       ) baseline on true
       left join lateral (
         select * from market_snapshots ms
          where ms.outcome_id = mo.id and ms.observed_at > $3
          order by ms.observed_at desc limit 1
       ) current on true
      where mo.market_id = $1 and mo.token_id = $2`,
    [base.market_id, tokenId, base.occurred_at],
  );
  const snapshot = market.rows[0];
  if (!snapshot) throw new Error(`selected outcome token ${tokenId} is no longer registered`);

  const evidenceIds = signal.evidenceIds;
  const evidence =
    evidenceIds.length === 0
      ? { rows: [] as EvidenceRow[] }
      : await pool.query<EvidenceRow>(
          `select id::text, coalesce(title, 'Untitled evidence') as title, url,
                  greatest(0, extract(epoch from (now() - coalesce(published_at, retrieved_at))))::float8 as age_seconds
             from evidence where id = any($1::uuid[])`,
          [evidenceIds],
        );
  const evidenceAgeSeconds =
    evidence.rows.length > 0 ? Math.max(...evidence.rows.map((row) => row.age_seconds)) : 1e12;
  const cooldown = await pool.query<{ exists: boolean }>(
    `select exists (
       select 1 from alerts a
        where a.market_id = $1 and a.status = 'sent'
          and a.sent_at >= now() - make_interval(mins => $2)
     )`,
    [base.market_id, thresholds.cooldownMinutes],
  );

  return {
    runId,
    marketId: base.market_id,
    marketTitle: base.market_title,
    eventOccurredAt: base.occurred_at,
    outcomeId: snapshot.outcome_id,
    outcomeName: snapshot.outcome_name,
    tokenId,
    signal,
    baselineSnapshotId: snapshot.baseline_snapshot_id ?? undefined,
    baselinePrice: numeric(snapshot.baseline_price),
    baselineObservedAt: snapshot.baseline_observed_at ?? undefined,
    currentSnapshotId: snapshot.current_snapshot_id ?? undefined,
    currentPrice: numeric(snapshot.current_price),
    currentObservedAt: snapshot.current_observed_at ?? undefined,
    spreadBps: snapshot.spread_bps ?? 0,
    depthUsd: numeric(snapshot.depth_usd) ?? 0,
    evidenceAgeSeconds,
    evidence: evidence.rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url ?? undefined,
    })),
    thresholds,
    inCooldown: cooldown.rows[0]?.exists ?? false,
  };
}

function evaluateContext(context: MatcherContext): LagResult {
  if (
    context.baselinePrice === undefined ||
    !context.baselineObservedAt ||
    context.currentPrice === undefined ||
    !context.currentObservedAt
  ) {
    const failedGates = [
      ...(context.baselinePrice === undefined || !context.baselineObservedAt
        ? ['missing_pre_event_baseline']
        : []),
      ...(context.currentPrice === undefined || !context.currentObservedAt
        ? ['missing_post_event_snapshot']
        : []),
    ];
    return {
      action: 'needs_review',
      observedMoveBps: 0,
      lagBps: context.signal.expectedMoveBps,
      failedGates,
    };
  }

  return evaluateLag(
    {
      signal: context.signal,
      preEventPrice: context.baselinePrice,
      preEventObservedAt: context.baselineObservedAt,
      currentPrice: context.currentPrice,
      currentObservedAt: context.currentObservedAt,
      eventOccurredAt: context.eventOccurredAt,
      spreadBps: context.spreadBps,
      depthUsd: context.depthUsd,
      evidenceAgeSeconds: context.evidenceAgeSeconds,
      inCooldown: context.inCooldown,
    },
    context.thresholds,
  );
}

export function composeTelegramAlert(
  context: Pick<
    MatcherContext,
    'marketTitle' | 'outcomeName' | 'currentPrice' | 'signal' | 'evidence'
  >,
  side: Side,
  lag: Pick<LagResult, 'lagBps'>,
  traceId: string,
): string {
  const signalLabel = side === 'buy_yes' ? 'BUY YES' : 'BUY NO';
  const evidence =
    context.evidence.length > 0
      ? context.evidence
          .map((item, index) => `${index + 1}. ${item.title}${item.url ? ` — ${item.url}` : ''}`)
          .join('\n')
      : 'No citable evidence available';
  const price = context.currentPrice === undefined ? 'unavailable' : `${Math.round(context.currentPrice * 100)}c`;

  return `EDGE DESK ALERT

Market: ${context.marketTitle}
Signal: ${signalLabel} — ${context.outcomeName}
Confidence: ${Math.round(context.signal.confidence * 100)}%
Current price: ${price}
Estimated remaining lag: ${(lag.lagBps / 100).toFixed(1)} pts

Why:
${context.signal.summary}

Evidence:
${evidence}

Trace: ${traceId}
Mode: notification only`;
}

async function persistMatcherFailure(
  pool: pg.Pool,
  claimed: ClaimedMatcherRun,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error).slice(0, 4_000);
  const code = error instanceof Error ? error.name : 'UnknownError';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update run_steps set status='failed', completed_at=now(), error_code=$2, error_message=$3
        where id=$1`,
      [claimed.stepId, code, message],
    );
    await client.query(
      `update agent_runs set status='failed', completed_at=now(), error_code=$2, error_message=$3
        where id=$1`,
      [claimed.runId, code, message],
    );
    await client.query('commit');
  } catch (persistError) {
    await client.query('rollback');
    throw new AggregateError([error, persistError], 'matcher and failure persistence both failed');
  } finally {
    client.release();
  }
}

interface SnapshotContextRow {
  outcome_id: string;
  outcome_name: string;
  token_id: string;
  baseline_snapshot_id: string | null;
  baseline_price: string | null;
  baseline_observed_at: Date | null;
  current_snapshot_id: string | null;
  current_price: string | null;
  current_observed_at: Date | null;
  spread_bps: number | null;
  depth_usd: string | null;
}

interface EvidenceRow {
  id: string;
  title: string;
  url: string | null;
  age_seconds: number;
}

const DEFAULT_THRESHOLDS: LagThresholds & { cooldownMinutes: number } = {
  minEvidenceConfidence: 0.7,
  maxEvidenceAgeSeconds: 300,
  maxSnapshotAgeSeconds: 60,
  maxSpreadBps: 500,
  minDepthUsd: 100,
  minLagBps: 300,
  cooldownMinutes: 30,
};

function parseThresholds(value: unknown): LagThresholds & { cooldownMinutes: number } {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    minEvidenceConfidence: threshold(raw, ['minEvidenceConfidence', 'minConfidence'], DEFAULT_THRESHOLDS.minEvidenceConfidence),
    maxEvidenceAgeSeconds: threshold(raw, ['maxEvidenceAgeSeconds'], DEFAULT_THRESHOLDS.maxEvidenceAgeSeconds),
    maxSnapshotAgeSeconds: threshold(raw, ['maxSnapshotAgeSeconds'], DEFAULT_THRESHOLDS.maxSnapshotAgeSeconds),
    maxSpreadBps: threshold(raw, ['maxSpreadBps'], DEFAULT_THRESHOLDS.maxSpreadBps),
    minDepthUsd: threshold(raw, ['minDepthUsd', 'minLiquidityUsd'], DEFAULT_THRESHOLDS.minDepthUsd),
    minLagBps: threshold(raw, ['minLagBps'], DEFAULT_THRESHOLDS.minLagBps),
    cooldownMinutes: threshold(raw, ['cooldownMinutes'], DEFAULT_THRESHOLDS.cooldownMinutes),
  };
}

function threshold(raw: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return fallback;
}

function parseStoredSignal(value: unknown): SpecialistSignal {
  const signal = object(value, 'signal');
  if (signal.category !== 'sports' && signal.category !== 'geopolitics' && signal.category !== 'crypto') {
    throw new Error('stored signal has an invalid category');
  }
  if (signal.direction !== 'yes_up' && signal.direction !== 'yes_down') {
    throw new Error('stored signal has an invalid direction');
  }
  if (typeof signal.expectedMoveBps !== 'number' || typeof signal.confidence !== 'number') {
    throw new Error('stored signal has invalid numeric fields');
  }
  return {
    category: signal.category,
    direction: signal.direction,
    expectedMoveBps: signal.expectedMoveBps,
    confidence: signal.confidence,
    summary: string(signal.summary, 'signal.summary'),
    evidenceIds: stringArray(signal.evidenceIds, 'signal.evidenceIds'),
    riskFlags: stringArray(signal.riskFlags, 'signal.riskFlags'),
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a string`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${path} must be a string array`);
  }
  return value as string[];
}

function numeric(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function envPositiveInteger(name: string, fallback: number, env = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
