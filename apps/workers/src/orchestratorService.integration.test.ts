// Integration tests for orchestratorService.ts against a real Postgres instance.
// Unlike hermesClient.test.ts/orchestrator.test.ts (mocked, no I/O), these prove the
// actual SQL: FOR UPDATE SKIP LOCKED claiming, the lateral-join baseline/current
// snapshot mapping, and the transactional persistence writes.
//
// Requires DATABASE_URL pointed at a disposable Postgres with migrations applied
// (see docker-compose.yml + `npm run db:migrate`). Skips itself if unset so plain
// `npm test` stays infra-free for teammates without a running database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import type { HermesClient, HermesRunResult } from './hermesClient.js';
import { HermesOrchestrator } from './orchestrator.js';
import { claimNextQueuedRun, loadOrchestrationInput, processAgentRun } from './orchestratorService.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe(
  'orchestratorService against real Postgres',
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

    test('claims the oldest queued run first and leaves already-running runs alone', async () => {
      const marketId = await seedMarket(pool);
      const eventId = await seedEvent(pool, marketId);
      const older = await seedAgentRun(pool, marketId, eventId, {
        status: 'queued',
        startedAt: '2026-01-01T00:00:00Z',
      });
      const newer = await seedAgentRun(pool, marketId, eventId, {
        status: 'queued',
        startedAt: '2026-01-01T00:01:00Z',
      });
      await seedAgentRun(pool, marketId, eventId, { status: 'running' });

      assert.equal(await claimNextQueuedRun(pool), older);
      const claimedRow = await pool.query('select status from agent_runs where id = $1', [older]);
      assert.equal(claimedRow.rows[0]?.status, 'running');

      assert.equal(await claimNextQueuedRun(pool), newer);
      assert.equal(await claimNextQueuedRun(pool), undefined);
    });

    test('does not let two concurrent claimants take the same row', async () => {
      const marketId = await seedMarket(pool);
      const eventId = await seedEvent(pool, marketId);
      const runA = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });
      const runB = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });

      const [first, second] = await Promise.all([claimNextQueuedRun(pool), claimNextQueuedRun(pool)]);

      assert.notEqual(first, second);
      assert.deepEqual([first, second].sort(), [runA, runB].sort());
    });

    test('loadOrchestrationInput maps the market, event, evidence, and baseline/current snapshots', async () => {
      const marketId = await seedMarket(pool, { polymarketMarketId: 'poly-load-1', category: 'sports' });
      const outcomeId = await seedOutcome(pool, marketId, { name: 'England', tokenId: 'token-england' });
      const eventId = await seedEvent(pool, marketId, {
        occurredAt: '2026-07-12T14:33:00Z',
        eventText: 'England goal',
      });
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.5, observedAt: '2026-07-12T14:32:00Z' });
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.54, observedAt: '2026-07-12T14:34:00Z' });
      const evidenceId = await seedEvidence(pool, eventId, { title: 'Live feed', confidence: 0.9 });
      const runId = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });

      const input = await loadOrchestrationInput(pool, runId);

      assert.equal(input.event.marketId, 'poly-load-1');
      assert.equal(input.event.category, 'sports');
      assert.equal(input.event.eventText, 'England goal');
      assert.equal(input.outcomes.length, 1);
      assert.equal(input.outcomes[0]?.tokenId, 'token-england');
      assert.equal(input.outcomes[0]?.baseline?.yesPrice, 0.5);
      assert.equal(input.outcomes[0]?.current?.yesPrice, 0.54);
      assert.equal(input.evidence.length, 1);
      assert.equal(input.evidence[0]?.id, evidenceId);
      assert.equal(input.evidence[0]?.title, 'Live feed');
    });

    test('loadOrchestrationInput leaves baseline/current undefined when no snapshot exists on that side', async () => {
      const marketId = await seedMarket(pool, { polymarketMarketId: 'poly-load-2' });
      const outcomeId = await seedOutcome(pool, marketId, { tokenId: 'token-only-current' });
      const eventId = await seedEvent(pool, marketId, { occurredAt: '2026-07-12T14:33:00Z' });
      // Only a post-event snapshot exists; no pre-event baseline.
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.6, observedAt: '2026-07-12T14:40:00Z' });
      const runId = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });

      const input = await loadOrchestrationInput(pool, runId);

      assert.equal(input.outcomes[0]?.baseline, undefined);
      assert.equal(input.outcomes[0]?.current?.yesPrice, 0.6);
    });

    test('processAgentRun persists a successful Hermes analysis into run_steps and agent_runs', async () => {
      const marketId = await seedMarket(pool, { polymarketMarketId: 'poly-success' });
      const outcomeId = await seedOutcome(pool, marketId, { name: 'England', tokenId: 'token-england' });
      const eventId = await seedEvent(pool, marketId, { occurredAt: '2026-07-12T14:33:00Z' });
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.5, observedAt: '2026-07-12T14:32:00Z' });
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.54, observedAt: '2026-07-12T14:34:00Z' });
      const evidenceId = await seedEvidence(pool, eventId);
      const runId = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });

      const orchestrator = new HermesOrchestrator(new StubHermesClient(completedRun(evidenceId)));
      const result = await processAgentRun(pool, orchestrator, runId);

      assert.equal(result.category, 'sports');
      assert.equal(result.review.accepted, true);

      const runRow = await pool.query(
        'select status, specialist, hermes_task_id, model, input_tokens, output_tokens from agent_runs where id = $1',
        [runId],
      );
      assert.equal(runRow.rows[0]?.specialist, 'sports');
      assert.equal(runRow.rows[0]?.hermes_task_id, 'hermes-run-1');
      assert.equal(runRow.rows[0]?.input_tokens, 10);

      const stepRow = await pool.query(
        `select status, output from run_steps where run_id = $1 and name = 'hermes_orchestration'`,
        [runId],
      );
      assert.equal(stepRow.rows[0]?.status, 'completed');
      assert.ok(stepRow.rows[0]?.output);
    });

    test('processAgentRun marks the run failed when Hermes returns invalid JSON', async () => {
      const marketId = await seedMarket(pool, { polymarketMarketId: 'poly-failure' });
      const outcomeId = await seedOutcome(pool, marketId, { tokenId: 'token-england' });
      const eventId = await seedEvent(pool, marketId);
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.5, observedAt: '2026-07-12T14:32:00Z' });
      await seedEvidence(pool, eventId);
      const runId = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });

      const orchestrator = new HermesOrchestrator(
        new StubHermesClient({ runId: 'hermes-run-x', output: 'not json at all' }),
      );

      await assert.rejects(() => processAgentRun(pool, orchestrator, runId));

      const runRow = await pool.query('select status, error_message from agent_runs where id = $1', [runId]);
      assert.equal(runRow.rows[0]?.status, 'failed');
      assert.ok(runRow.rows[0]?.error_message);

      const stepRow = await pool.query(
        `select status, error_message from run_steps where run_id = $1 and name = 'hermes_orchestration'`,
        [runId],
      );
      assert.equal(stepRow.rows[0]?.status, 'failed');
    });

    test('processAgentRun retries as a new attempt after a prior failure on the same run', async () => {
      const marketId = await seedMarket(pool, { polymarketMarketId: 'poly-retry' });
      const outcomeId = await seedOutcome(pool, marketId, { tokenId: 'token-england' });
      const eventId = await seedEvent(pool, marketId, { occurredAt: '2026-07-12T14:33:00Z' });
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.5, observedAt: '2026-07-12T14:32:00Z' });
      await seedSnapshot(pool, marketId, outcomeId, { yesPrice: 0.54, observedAt: '2026-07-12T14:34:00Z' });
      const evidenceId = await seedEvidence(pool, eventId);
      const runId = await seedAgentRun(pool, marketId, eventId, { status: 'queued' });

      const failing = new HermesOrchestrator(
        new StubHermesClient({ runId: 'hermes-run-fail', output: 'garbage' }),
      );
      await assert.rejects(() => processAgentRun(pool, failing, runId));

      const succeeding = new HermesOrchestrator(new StubHermesClient(completedRun(evidenceId)));
      await processAgentRun(pool, succeeding, runId);

      const steps = await pool.query(
        `select attempt, status from run_steps where run_id = $1 and name = 'hermes_orchestration' order by attempt`,
        [runId],
      );
      assert.deepEqual(
        steps.rows.map((row) => [row.attempt, row.status]),
        [
          [1, 'failed'],
          [2, 'completed'],
        ],
      );
    });
  },
);

class StubHermesClient implements HermesClient {
  constructor(private readonly result: HermesRunResult) {}

  async run(): Promise<HermesRunResult> {
    return this.result;
  }
}

function completedRun(evidenceId: string): HermesRunResult {
  return {
    runId: 'hermes-run-1',
    sessionId: 'edge-desk-session-1',
    model: 'hermes-agent',
    output: JSON.stringify({
      category: 'sports',
      selectedOutcomeTokenId: 'token-england',
      plan: [{ role: 'sports_specialist', task: 'Estimate goal impact' }],
      signal: {
        category: 'sports',
        direction: 'yes_up',
        expectedMoveBps: 900,
        confidence: 0.8,
        summary: 'England scored and now leads.',
        evidenceIds: [evidenceId],
        riskFlags: [],
      },
      review: { accepted: true, issues: [] },
    }),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

async function seedMarket(
  pool: pg.Pool,
  overrides: Partial<{ polymarketMarketId: string; title: string; category: string }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into markets (polymarket_market_id, title, category)
     values ($1, $2, $3) returning id::text as id`,
    [
      overrides.polymarketMarketId ?? `market-${randomUUID()}`,
      overrides.title ?? 'Test market',
      overrides.category ?? 'sports',
    ],
  );
  return result.rows[0]!.id;
}

async function seedOutcome(
  pool: pg.Pool,
  marketId: string,
  overrides: Partial<{ name: string; tokenId: string }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into market_outcomes (market_id, name, token_id)
     values ($1, $2, $3) returning id::text as id`,
    [marketId, overrides.name ?? 'Outcome', overrides.tokenId ?? `token-${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function seedEvent(
  pool: pg.Pool,
  marketId: string,
  overrides: Partial<{ occurredAt: string; eventText: string; sourceEventId: string }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into events (market_id, source, source_event_id, event_type, event_text, occurred_at)
     values ($1, 'test_feed', $2, 'goal', $3, $4) returning id::text as id`,
    [
      marketId,
      overrides.sourceEventId ?? `evt-${randomUUID()}`,
      overrides.eventText ?? 'Test event',
      overrides.occurredAt ?? new Date().toISOString(),
    ],
  );
  return result.rows[0]!.id;
}

async function seedSnapshot(
  pool: pg.Pool,
  marketId: string,
  outcomeId: string,
  overrides: Partial<{ yesPrice: number; observedAt: string }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into market_snapshots
       (market_id, outcome_id, yes_price, best_bid, best_ask, spread_bps, depth_usd, observed_at)
     values ($1, $2, $3, $3, $3, 100, 10000, $4) returning id::text as id`,
    [marketId, outcomeId, overrides.yesPrice ?? 0.5, overrides.observedAt ?? new Date().toISOString()],
  );
  return result.rows[0]!.id;
}

async function seedEvidence(
  pool: pg.Pool,
  eventId: string,
  overrides: Partial<{ title: string; confidence: number }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into evidence (event_id, title, retrieved_at, confidence)
     values ($1, $2, now(), $3) returning id::text as id`,
    [eventId, overrides.title ?? 'Test evidence', overrides.confidence ?? 0.9],
  );
  return result.rows[0]!.id;
}

async function seedAgentRun(
  pool: pg.Pool,
  marketId: string,
  eventId: string,
  overrides: Partial<{ status: string; startedAt: string }> = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into agent_runs (market_id, event_id, status, started_at)
     values ($1, $2, $3, $4) returning id::text as id`,
    [marketId, eventId, overrides.status ?? 'queued', overrides.startedAt ?? new Date().toISOString()],
  );
  return result.rows[0]!.id;
}
