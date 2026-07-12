// Integration tests for outcomeTracker.ts against a real Postgres instance.
// Unlike outcomeTracker.test.ts (pure labelOutcome, no I/O), these prove the actual
// claim SQL (outcome_jobs -> alerts -> decisions -> market_outcomes -> markets),
// FOR UPDATE SKIP LOCKED due-job filtering, and the transactional outcomes write.
// The CLOB snapshot fetch is injected (SnapshotFetcher) so no real network call
// happens. Requires DATABASE_URL; self-skips otherwise (see docker-compose.yml).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import {
  claimNextOutcomeJob,
  processOutcomeJob,
  type SnapshotFetcher,
} from './outcomeTracker.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe(
  'outcomeTracker against real Postgres',
  { skip: DATABASE_URL ? false : 'set DATABASE_URL to a disposable Postgres instance to run these' },
  () => {
    let pool: pg.Pool;

    before(() => {
      pool = new pg.Pool({ connectionString: DATABASE_URL });
    });

    after(async () => {
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query(`truncate table
        outcomes, outcome_jobs, delivery_outbox, alerts, decisions,
        run_steps, agent_runs, evidence, market_snapshots, events,
        market_outcomes, markets, replay_runs
        restart identity cascade`);
    });

    test('claims a due job, marks it checking, and increments attempt_count', async () => {
      const seeded = await seedReadyJob(pool, {});

      const claimed = await claimNextOutcomeJob(pool);

      assert.equal(claimed?.jobId, seeded.jobId);
      assert.equal(claimed?.alertId, seeded.alertId);
      assert.equal(claimed?.tokenId, seeded.tokenId);
      assert.equal(claimed?.priceAtAlert, 0.5);
      const row = await pool.query('select status, attempt_count from outcome_jobs where id = $1', [
        seeded.jobId,
      ]);
      assert.equal(row.rows[0]?.status, 'checking');
      assert.equal(row.rows[0]?.attempt_count, 1);
    });

    test('does not claim a job scheduled in the future', async () => {
      await seedReadyJob(pool, { scheduledFor: new Date(Date.now() + 60_000) });

      assert.equal(await claimNextOutcomeJob(pool), undefined);
    });

    test('does not let two concurrent claimants take the same job', async () => {
      const a = await seedReadyJob(pool, {});
      const b = await seedReadyJob(pool, {});

      const [first, second] = await Promise.all([claimNextOutcomeJob(pool), claimNextOutcomeJob(pool)]);

      assert.notEqual(first?.jobId, second?.jobId);
      assert.deepEqual([first?.jobId, second?.jobId].sort(), [a.jobId, b.jobId].sort());
    });

    test('labels correct and persists the fresh snapshot when price moves with a buy_yes call', async () => {
      const seeded = await seedReadyJob(pool, { side: 'buy_yes', priceAtAlert: 0.5 });
      const job = await claimNextOutcomeJob(pool);
      const fetchSnapshot: SnapshotFetcher = async (tokenId, meta) =>
        stubSnapshot(tokenId, meta, 0.6);

      const result = await processOutcomeJob(pool, job!, 50, fetchSnapshot);

      assert.equal(result.evalLabel, 'correct');
      const outcomeRow = await pool.query(
        'select eval_label, signed_move_bps, price_at_check, snapshot_id from outcomes where id = $1',
        [result.outcomeId],
      );
      assert.equal(outcomeRow.rows[0]?.eval_label, 'correct');
      assert.equal(outcomeRow.rows[0]?.signed_move_bps, 1000);
      assert.ok(outcomeRow.rows[0]?.snapshot_id, 'fresh snapshot should be persisted');
      const jobRow = await pool.query('select status from outcome_jobs where id = $1', [seeded.jobId]);
      assert.equal(jobRow.rows[0]?.status, 'done');
    });

    test('labels wrong when price moves against a buy_no call', async () => {
      const job = await seedAndClaim(pool, { side: 'buy_no', priceAtAlert: 0.5 });
      const fetchSnapshot: SnapshotFetcher = async (tokenId, meta) =>
        stubSnapshot(tokenId, meta, 0.6); // yes price rose -> bad for a buy_no call

      const result = await processOutcomeJob(pool, job, 50, fetchSnapshot);

      assert.equal(result.evalLabel, 'wrong');
    });

    test('labels flat when the move is within the threshold', async () => {
      const job = await seedAndClaim(pool, { side: 'buy_yes', priceAtAlert: 0.5 });
      const fetchSnapshot: SnapshotFetcher = async (tokenId, meta) =>
        stubSnapshot(tokenId, meta, 0.503); // +30bps, under the 50bps threshold

      const result = await processOutcomeJob(pool, job, 50, fetchSnapshot);

      assert.equal(result.evalLabel, 'flat');
    });

    test('labels invalid_data and still marks the job done when the snapshot fetch fails', async () => {
      const seeded = await seedReadyJob(pool, {});
      const job = await claimNextOutcomeJob(pool);
      const fetchSnapshot: SnapshotFetcher = async () => {
        throw new Error('CLOB unreachable');
      };

      const result = await processOutcomeJob(pool, job!, 50, fetchSnapshot);

      assert.equal(result.evalLabel, 'invalid_data');
      const jobRow = await pool.query('select status from outcome_jobs where id = $1', [seeded.jobId]);
      assert.equal(jobRow.rows[0]?.status, 'done');
    });

    test('labels invalid_data without fetching when the decision has no alert-time price', async () => {
      const seeded = await seedReadyJob(pool, { withAlertPrice: false });
      const job = await claimNextOutcomeJob(pool);
      assert.equal(job?.priceAtAlert, undefined);
      let fetchCalled = false;
      const fetchSnapshot: SnapshotFetcher = async (tokenId, meta) => {
        fetchCalled = true;
        return stubSnapshot(tokenId, meta, 0.6);
      };

      const result = await processOutcomeJob(pool, job!, 50, fetchSnapshot);

      assert.equal(result.evalLabel, 'invalid_data');
      assert.equal(fetchCalled, false);
      const outcomeRow = await pool.query('select notes from outcomes where id = $1', [result.outcomeId]);
      assert.match(outcomeRow.rows[0]?.notes ?? '', /no usable alert-time price/);
      const jobRow = await pool.query('select status from outcome_jobs where id = $1', [seeded.jobId]);
      assert.equal(jobRow.rows[0]?.status, 'done');
    });
  },
);

function stubSnapshot(
  tokenId: string,
  meta: { marketId?: string; outcome?: string },
  yesPrice: number,
): { snapshot: import('@edge-desk/contracts').MarketSnapshot; raw: unknown } {
  return {
    snapshot: {
      marketId: meta.marketId ?? '',
      outcome: meta.outcome ?? '',
      tokenId,
      yesPrice,
      bestBid: yesPrice - 0.01,
      bestAsk: yesPrice + 0.01,
      spreadBps: 200,
      depthUsd: 5_000,
      observedAt: new Date().toISOString(),
    },
    raw: { stub: true },
  };
}

interface SeedOptions {
  side?: 'buy_yes' | 'buy_no';
  priceAtAlert?: number;
  scheduledFor?: Date;
  withAlertPrice?: boolean;
}

interface SeededJob {
  jobId: string;
  alertId: string;
  tokenId: string;
}

async function seedReadyJob(pool: pg.Pool, options: SeedOptions): Promise<SeededJob> {
  const side = options.side ?? 'buy_yes';
  const priceAtAlert = options.priceAtAlert ?? 0.5;
  const withAlertPrice = options.withAlertPrice ?? true;
  const scheduledFor = options.scheduledFor ?? new Date(Date.now() - 1_000);
  const tokenId = `token-${randomUUID()}`;

  const market = await pool.query<{ id: string }>(
    `insert into markets (polymarket_market_id, title, category)
     values ($1, 'Test market', 'sports') returning id`,
    [`market-${randomUUID()}`],
  );
  const marketId = market.rows[0]!.id;

  const outcome = await pool.query<{ id: string }>(
    `insert into market_outcomes (market_id, name, token_id)
     values ($1, 'Outcome', $2) returning id`,
    [marketId, tokenId],
  );
  const outcomeId = outcome.rows[0]!.id;

  const run = await pool.query<{ id: string }>(
    `insert into agent_runs (market_id) values ($1) returning id`,
    [marketId],
  );
  const runId = run.rows[0]!.id;

  let snapshotId: string | null = null;
  if (withAlertPrice) {
    const snapshot = await pool.query<{ id: string }>(
      `insert into market_snapshots (market_id, outcome_id, yes_price, observed_at)
       values ($1, $2, $3, now()) returning id`,
      [marketId, outcomeId, priceAtAlert],
    );
    snapshotId = snapshot.rows[0]!.id;
  }

  const decision = await pool.query<{ id: string }>(
    `insert into decisions (run_id, market_id, outcome_id, action, side, current_snapshot_id)
     values ($1, $2, $3, 'notify', $4, $5) returning id`,
    [runId, marketId, outcomeId, side, snapshotId],
  );
  const decisionId = decision.rows[0]!.id;

  const alert = await pool.query<{ id: string }>(
    `insert into alerts (decision_id, run_id, market_id, message)
     values ($1, $2, $3, 'test alert') returning id`,
    [decisionId, runId, marketId],
  );
  const alertId = alert.rows[0]!.id;

  const job = await pool.query<{ id: string }>(
    `insert into outcome_jobs (alert_id, horizon_minutes, scheduled_for)
     values ($1, 2, $2) returning id`,
    [alertId, scheduledFor],
  );

  return { jobId: job.rows[0]!.id, alertId, tokenId };
}

async function seedAndClaim(pool: pg.Pool, options: SeedOptions) {
  await seedReadyJob(pool, options);
  const job = await claimNextOutcomeJob(pool);
  if (!job) throw new Error('expected a claimable job');
  return job;
}
