// POST /v1/events — live event/news/webhook ingest (docs/TECH_ARCHITECTURE.md §4.2, §6).
// Must: dedupe on (source, sourceEventId), store occurredAt separately from receivedAt,
// resolve market + category before dispatch, and return 202 with a durable runId
// (never acknowledge work that is not durable — DB down means 503, not a fake ack).

import type { FastifyInstance } from 'fastify';
import { getPool } from '@edge-desk/db';
import type { NormalizedEvent } from '@edge-desk/contracts';

const bodySchema = {
  type: 'object',
  required: [
    'sourceEventId',
    'source',
    'marketId',
    'category',
    'eventType',
    'eventText',
    'occurredAt',
  ],
  additionalProperties: false,
  properties: {
    sourceEventId: { type: 'string', minLength: 1 },
    source: { type: 'string', minLength: 1 },
    marketId: { type: 'string', minLength: 1 }, // Polymarket market id, not our uuid
    category: { type: 'string', enum: ['sports', 'geopolitics', 'crypto'] },
    eventType: { type: 'string', minLength: 1 },
    eventText: { type: 'string', minLength: 1 },
    occurredAt: { type: 'string', format: 'date-time' },
    sourceUrl: { type: 'string' },
    data: { type: 'object' },
  },
} as const;

export async function eventsRoutes(app: FastifyInstance) {
  app.post<{ Body: NormalizedEvent }>(
    '/v1/events',
    { schema: { body: bodySchema } },
    async (req, reply) => {
      const event = req.body;
      const pool = getPool();

      let marketRow: { id: string; category: string } | undefined;
      try {
        const res = await pool.query(
          `select id, category from markets where polymarket_market_id = $1`,
          [event.marketId],
        );
        marketRow = res.rows[0];
      } catch (err) {
        req.log.error({ err }, 'market lookup failed');
        return reply.code(503).send({ error: 'database_unavailable' });
      }

      if (!marketRow) {
        return reply.code(404).send({ error: 'unknown_market' });
      }
      if (marketRow.category !== event.category) {
        return reply.code(422).send({
          error: 'category_mismatch',
          message: `market is '${marketRow.category}', event says '${event.category}'`,
        });
      }

      // Event insert + run creation are ONE transaction: a 202 means both are durable.
      const client = await pool.connect().catch(() => undefined);
      if (!client) {
        return reply.code(503).send({ error: 'database_unavailable' });
      }
      try {
        await client.query('begin');

        const inserted = await client.query(
          `insert into events
             (market_id, source, source_event_id, event_type, event_text,
              source_url, payload, occurred_at, mode)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'live')
           on conflict (source, source_event_id) where mode = 'live' do nothing
           returning id`,
          [
            marketRow.id,
            event.source,
            event.sourceEventId,
            event.eventType,
            event.eventText,
            event.sourceUrl ?? null,
            JSON.stringify(event.data ?? {}),
            event.occurredAt,
          ],
        );

        if (inserted.rowCount === 0) {
          // Duplicate: return the existing event + its most recent run, no new run.
          const existing = await client.query(
            `select e.id as event_id,
                    (select r.id from agent_runs r
                      where r.event_id = e.id
                      order by r.started_at desc limit 1) as run_id
             from events e
             where e.source = $1 and e.source_event_id = $2 and e.mode = 'live'`,
            [event.source, event.sourceEventId],
          );
          await client.query('commit');
          return reply.code(202).send({
            eventId: existing.rows[0].event_id,
            runId: existing.rows[0].run_id,
            status: 'accepted',
            duplicate: true,
          });
        }

        const eventId: string = inserted.rows[0].id;
        const run = await client.query(
          `insert into agent_runs (market_id, event_id, specialist, status, mode)
           values ($1, $2, $3, 'pending', 'live')
           returning id`,
          [marketRow.id, eventId, event.category],
        );
        await client.query('commit');

        return reply.code(202).send({
          eventId,
          runId: run.rows[0].id,
          status: 'accepted',
          duplicate: false,
        });
      } catch (err) {
        await client.query('rollback').catch(() => undefined);
        req.log.error({ err }, 'event ingest failed');
        return reply.code(503).send({ error: 'database_unavailable' });
      } finally {
        client.release();
      }
    },
  );
}
