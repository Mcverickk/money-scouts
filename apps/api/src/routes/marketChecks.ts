// POST /v1/market-checks — scheduled or manual market evaluation (docs/TECH_ARCHITECTURE.md §6).

import type { FastifyInstance } from 'fastify';

export async function marketChecksRoutes(app: FastifyInstance) {
  app.post('/v1/market-checks', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
