// POST /v1/events — live event/news/webhook ingest (docs/TECH_ARCHITECTURE.md §4.2, §6).
// Must: dedupe on (source, sourceEventId), store occurredAt separately from receivedAt,
// resolve market + category before dispatch, and return 202 with a durable runId
// (never acknowledge work that is not durable).

import type { FastifyInstance } from 'fastify';

export async function eventsRoutes(app: FastifyInstance) {
  app.post('/v1/events', async (_req, reply) => {
    return reply.code(501).send({ error: 'not_implemented' });
  });
}
