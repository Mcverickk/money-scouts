// POST /v1/markets — operator registers a Polymarket market to watch
// (docs/TECH_ARCHITECTURE.md §4.1, §6). Resolves metadata + outcome token IDs via the
// Gamma adapter, upserts markets/market_outcomes, then takes a best-effort initial
// baseline snapshot per outcome via the CLOB REST adapter (registration must succeed
// even when snapshots fail — the matcher just falls back to needs_review without one).

import type { FastifyInstance } from 'fastify';
import { getPool } from '@edge-desk/db';
import { gamma, clob } from '@edge-desk/integrations';

const bodySchema = {
  type: 'object',
  required: ['slugOrId', 'category'],
  additionalProperties: false,
  properties: {
    slugOrId: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: ['sports', 'geopolitics', 'crypto'] },
    gameSlug: { type: 'string', minLength: 1 },
    thresholds: { type: 'object' },
  },
} as const;

interface MarketsBody {
  slugOrId: string;
  category: 'sports' | 'geopolitics' | 'crypto';
  gameSlug?: string;
  thresholds?: Record<string, unknown>;
}

export async function marketsRoutes(app: FastifyInstance) {
  app.post<{ Body: MarketsBody }>(
    '/v1/markets',
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const { slugOrId, category, gameSlug, thresholds } = req.body;

      let resolved: Awaited<ReturnType<typeof gamma.resolveMarket>>;
      try {
        resolved = await gamma.resolveMarket(slugOrId);
      } catch (err) {
        req.log.error({ err, slugOrId }, 'gamma.resolveMarket failed');
        return reply.code(502).send({
          error: 'market_resolution_failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const pool = getPool();
      const client = await pool.connect();
      let market: { id: string; title: string; category: string };
      let created: boolean;
      let outcomes: Array<{ id: string; name: string; tokenId: string }>;
      try {
        await client.query('begin');

        const inserted = await client.query(
          `insert into markets (polymarket_market_id, slug, title, category, game_slug, thresholds)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (polymarket_market_id) do nothing
           returning id, title, category`,
          [
            resolved.polymarketMarketId,
            resolved.slug,
            resolved.title,
            category,
            gameSlug ?? null,
            JSON.stringify(thresholds ?? {}),
          ],
        );
        created = inserted.rowCount === 1;
        if (created) {
          market = inserted.rows[0];
        } else {
          // Re-registration is how the operator updates the feed mapping/thresholds
          // (e.g. pointing a market at a new live game or a replay fixture slug).
          const existing = await client.query(
            `update markets
                set game_slug = coalesce($2, game_slug),
                    thresholds = coalesce($3, thresholds),
                    updated_at = now()
              where polymarket_market_id = $1
              returning id, title, category`,
            [
              resolved.polymarketMarketId,
              gameSlug ?? null,
              thresholds ? JSON.stringify(thresholds) : null,
            ],
          );
          market = existing.rows[0];
        }

        for (const outcome of resolved.outcomes) {
          await client.query(
            `insert into market_outcomes (market_id, name, token_id)
             values ($1, $2, $3)
             on conflict (market_id, token_id) do nothing`,
            [market.id, outcome.name, outcome.tokenId],
          );
        }
        const outcomeRows = await client.query(
          `select id, name, token_id from market_outcomes where market_id = $1`,
          [market.id],
        );
        outcomes = outcomeRows.rows.map((r) => ({
          id: r.id,
          name: r.name,
          tokenId: r.token_id,
        }));

        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        req.log.error({ err }, 'market registration failed');
        return reply.code(503).send({ error: 'database_unavailable' });
      } finally {
        client.release();
      }

      // Best-effort initial baselines: the matcher needs a pre-event baseline, but
      // registration must not fail because the CLOB is briefly unreachable.
      let baselineSnapshots = 0;
      for (const outcome of outcomes) {
        try {
          const { snapshot, raw } = await clob.fetchSnapshot(outcome.tokenId, {
            marketId: resolved.polymarketMarketId,
            outcome: outcome.name,
          });
          await pool.query(
            `insert into market_snapshots
               (market_id, outcome_id, yes_price, best_bid, best_ask, spread_bps,
                depth_usd, provider, provider_ref, raw_payload, observed_at, mode)
             values ($1, $2, $3, $4, $5, $6, $7, 'clob_rest', $8, $9, $10, 'live')`,
            [
              market.id,
              outcome.id,
              snapshot.yesPrice,
              snapshot.bestBid,
              snapshot.bestAsk,
              snapshot.spreadBps,
              snapshot.depthUsd,
              outcome.tokenId,
              JSON.stringify(raw ?? null),
              snapshot.observedAt,
            ],
          );
          baselineSnapshots += 1;
        } catch (err) {
          req.log.warn(
            { err, tokenId: outcome.tokenId },
            'baseline snapshot failed (registration continues)',
          );
        }
      }

      return reply.code(created ? 201 : 200).send({
        marketId: market.id,
        polymarketMarketId: resolved.polymarketMarketId,
        title: market.title,
        category: market.category,
        outcomes,
        baselineSnapshots,
      });
    },
  );
}
