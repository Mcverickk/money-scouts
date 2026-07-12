// POST /v1/market-checks — scheduled or manual market evaluation (docs/TECH_ARCHITECTURE.md §6).
// No triggering event: creates a pending agent_run with event_id null so the orchestrator
// evaluates the market's current state on demand (cron sweep, operator demo).

import type { FastifyInstance } from 'fastify';
import { getPool } from '@edge-desk/db';

const bodySchema = {
  type: 'object',
  required: ['marketId'],
  additionalProperties: false,
  properties: {
    marketId: { type: 'string', minLength: 1 }, // Polymarket market id
    reason: { type: 'string' },
  },
} as const;

interface MarketChecksBody {
  marketId: string;
  reason?: string;
}

export async function marketChecksRoutes(app: FastifyInstance) {
  app.post<{ Body: MarketChecksBody }>(
    '/v1/market-checks',
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const pool = getPool();
      try {
        const market = await pool.query(
          `select id, category from markets where polymarket_market_id = $1`,
          [req.body.marketId],
        );
        if (market.rowCount === 0) {
          return reply.code(404).send({ error: 'unknown_market' });
        }

        const run = await pool.query(
          `insert into agent_runs (market_id, event_id, specialist, status, mode)
           values ($1, null, $2, 'pending', 'live')
           returning id`,
          [market.rows[0].id, market.rows[0].category],
        );

        return reply.code(202).send({ runId: run.rows[0].id, status: 'accepted' });
      } catch (err) {
        req.log.error({ err }, 'market check failed');
        return reply.code(503).send({ error: 'database_unavailable' });
      }
    },
  );
}
