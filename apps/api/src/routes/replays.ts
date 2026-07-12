// POST /v1/replays — start a versioned replay fixture through the SAME ingest path as
// live events (docs/TECH_ARCHITECTURE.md §4.11). Replays never write synthetic rows
// directly into live tables; every generated row carries mode='replay' + replayRunId.

import type { FastifyInstance } from 'fastify';

export async function replaysRoutes(app: FastifyInstance) {
  app.post('/v1/replays', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
