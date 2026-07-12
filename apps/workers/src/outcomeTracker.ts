// Outcome tracker (docs/TECH_ARCHITECTURE.md §4.9).
// Claims due outcome_jobs (+2/+3/+5 min from sent_at — shortened from the spec's
// +10/+20/+40 for fast demo feedback; see alertSender.ts's envHorizonsMinutes),
// fetches a fresh snapshot, labels correct/wrong/flat/invalid_data with a versioned
// policy, and preserves both scheduled_for and checked_at — a late check must not
// masquerade as on-time. Intended to run from a frequent Hermes cron with
// no_agent=true (docs/HERMES_INTEGRATION.md); here it is one more polling worker
// process, consistent with orchestratorService/matcher/alertSender.

import type { MarketSnapshot } from '@edge-desk/contracts';
import { getPool, insertMarketSnapshot } from '@edge-desk/db';
import { clob } from '@edge-desk/integrations';
import type pg from 'pg';

export const OUTCOME_EVALUATION_POLICY_VERSION = 'sports-outcome-v1';

export type EvalLabel = 'correct' | 'wrong' | 'flat' | 'invalid_data';

/** Matches clob.fetchSnapshot's shape; injectable so tests don't hit the real CLOB REST API. */
export type SnapshotFetcher = (
  tokenId: string,
  meta: { marketId?: string; outcome?: string },
) => Promise<{ snapshot: MarketSnapshot; raw: unknown }>;

export interface OutcomeTrackerWorkerOptions {
  pool?: pg.Pool;
  pollIntervalMs?: number;
  /** |signedMoveBps| at or below this counts as 'flat' rather than correct/wrong. */
  flatThresholdBps?: number;
  fetchSnapshot?: SnapshotFetcher;
  signal?: AbortSignal;
  logger?: Pick<Console, 'info' | 'error'>;
}

export interface OutcomeResult {
  outcomeId: string;
  evalLabel: EvalLabel;
}

export interface ClaimedOutcomeJob {
  jobId: string;
  alertId: string;
  horizonMinutes: number;
  scheduledFor: Date;
  marketDbId: string;
  polymarketMarketId: string;
  outcomeDbId: string;
  tokenId: string;
  outcomeName: string;
  side: string;
  /** Yes-price at alert time, from the decision's current_snapshot_id. Missing = invalid_data. */
  priceAtAlert?: number;
}

/**
 * Claims due outcome_jobs one at a time in this worker process. Multiple worker
 * processes are safe: PostgreSQL row locks prevent double claims.
 */
export async function runOutcomeTrackerWorker(options: OutcomeTrackerWorkerOptions = {}): Promise<void> {
  const pool = options.pool ?? getPool();
  const pollIntervalMs =
    options.pollIntervalMs ?? envPositiveInteger('OUTCOME_TRACKER_POLL_INTERVAL_MS', 1_000);
  const flatThresholdBps =
    options.flatThresholdBps ?? envPositiveInteger('OUTCOME_FLAT_THRESHOLD_BPS', 50);
  const fetchSnapshot = options.fetchSnapshot ?? clob.fetchSnapshot;
  const logger = options.logger ?? console;

  logger.info('Outcome tracker worker started');
  while (!options.signal?.aborted) {
    const job = await claimNextOutcomeJob(pool);
    if (!job) {
      await abortableDelay(pollIntervalMs, options.signal);
      continue;
    }
    try {
      const result = await processOutcomeJob(pool, job, flatThresholdBps, fetchSnapshot);
      logger.info(
        `Outcome job ${job.jobId} labeled ${result.evalLabel} at +${job.horizonMinutes}m for alert ${job.alertId}`,
      );
    } catch (error) {
      logger.error(`Outcome job ${job.jobId} failed to persist: ${errorMessage(error)}`);
    }
  }
  logger.info('Outcome tracker worker stopped');
}

export async function claimNextOutcomeJob(pool: pg.Pool): Promise<ClaimedOutcomeJob | undefined> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query<OutcomeJobRow>(
      `select oj.id::text as job_id,
              oj.alert_id::text as alert_id,
              oj.horizon_minutes,
              oj.scheduled_for,
              m.id::text as market_db_id,
              m.polymarket_market_id,
              mo.id::text as outcome_db_id,
              mo.token_id,
              mo.name as outcome_name,
              d.side,
              ms.yes_price as price_at_alert
         from outcome_jobs oj
         join alerts a on a.id = oj.alert_id
         join decisions d on d.id = a.decision_id
         join market_outcomes mo on mo.id = d.outcome_id
         join markets m on m.id = d.market_id
         left join market_snapshots ms on ms.id = d.current_snapshot_id
        where oj.status = 'pending'
          and oj.scheduled_for <= now()
        order by oj.scheduled_for, oj.id
        for update of oj skip locked
        limit 1`,
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('commit');
      return undefined;
    }

    await client.query(
      `update outcome_jobs set status = 'checking', attempt_count = attempt_count + 1 where id = $1`,
      [row.job_id],
    );
    await client.query('commit');

    return {
      jobId: row.job_id,
      alertId: row.alert_id,
      horizonMinutes: row.horizon_minutes,
      scheduledFor: row.scheduled_for,
      marketDbId: row.market_db_id,
      polymarketMarketId: row.polymarket_market_id,
      outcomeDbId: row.outcome_db_id,
      tokenId: row.token_id,
      outcomeName: row.outcome_name,
      side: row.side ?? 'unknown',
      priceAtAlert: numeric(row.price_at_alert),
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Labels the job and writes the outcomes row + marks the job done, always in one
 * transaction — a snapshot-fetch failure becomes an 'invalid_data' outcome rather
 * than an unbounded retry, since a scheduled horizon check is a one-shot look, not
 * a delivery that must eventually succeed.
 */
export async function processOutcomeJob(
  pool: pg.Pool,
  job: ClaimedOutcomeJob,
  flatThresholdBps: number,
  fetchSnapshot: SnapshotFetcher = clob.fetchSnapshot,
): Promise<OutcomeResult> {
  const checkedAt = new Date();
  let snapshotId: string | null = null;
  let priceAtCheck: number | null = null;
  let signedMoveBps: number | null = null;
  let evalLabel: EvalLabel;
  let notes: string | null = null;

  if (job.priceAtAlert === undefined) {
    evalLabel = 'invalid_data';
    notes = 'decision has no usable alert-time price snapshot';
  } else if (job.side !== 'buy_yes' && job.side !== 'buy_no') {
    evalLabel = 'invalid_data';
    notes = `unrecognized decision side: ${job.side}`;
  } else {
    try {
      const { snapshot, raw } = await fetchSnapshot(job.tokenId, {
        marketId: job.polymarketMarketId,
        outcome: job.outcomeName,
      });
      priceAtCheck = snapshot.yesPrice;
      snapshotId = await insertMarketSnapshot(
        {
          market_id: job.marketDbId,
          outcome_id: job.outcomeDbId,
          yes_price: snapshot.yesPrice,
          best_bid: snapshot.bestBid,
          best_ask: snapshot.bestAsk,
          spread_bps: snapshot.spreadBps,
          depth_usd: snapshot.depthUsd,
          provider: 'clob_rest',
          provider_ref: 'outcome_tracker',
          raw_payload: raw,
          observed_at: snapshot.observedAt,
          mode: 'live',
        },
        pool,
      );
      const observedMoveBps = Math.round((priceAtCheck - job.priceAtAlert) * 10_000);
      signedMoveBps = observedMoveBps * (job.side === 'buy_yes' ? 1 : -1);
      evalLabel = labelOutcome(signedMoveBps, flatThresholdBps);
    } catch (error) {
      evalLabel = 'invalid_data';
      notes = `snapshot fetch failed: ${errorMessage(error)}`.slice(0, 2_000);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const inserted = await client.query<{ id: string }>(
      `insert into outcomes (
         outcome_job_id, alert_id, snapshot_id, scheduled_for, checked_at,
         horizon_minutes, price_at_check, signed_move_bps, eval_label,
         evaluation_policy_version, notes
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id::text`,
      [
        job.jobId,
        job.alertId,
        snapshotId,
        job.scheduledFor,
        checkedAt,
        job.horizonMinutes,
        priceAtCheck,
        signedMoveBps,
        evalLabel,
        OUTCOME_EVALUATION_POLICY_VERSION,
        notes,
      ],
    );
    await client.query(`update outcome_jobs set status = 'done' where id = $1`, [job.jobId]);
    await client.query('commit');
    return { outcomeId: inserted.rows[0]!.id, evalLabel };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** |signedMoveBps| at or below flatThresholdBps is 'flat'; otherwise sign decides correct/wrong. */
export function labelOutcome(signedMoveBps: number, flatThresholdBps: number): EvalLabel {
  if (Math.abs(signedMoveBps) <= flatThresholdBps) return 'flat';
  return signedMoveBps > 0 ? 'correct' : 'wrong';
}

interface OutcomeJobRow {
  job_id: string;
  alert_id: string;
  horizon_minutes: number;
  scheduled_for: Date;
  market_db_id: string;
  polymarket_market_id: string;
  outcome_db_id: string;
  token_id: string;
  outcome_name: string;
  side: string | null;
  price_at_alert: string | number | null;
}

function numeric(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
