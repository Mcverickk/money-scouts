// Typed query helpers for the ingestion path (plain pg, no ORM).
// Types here are local on purpose: @edge-desk/contracts is a shared seam owned
// elsewhere; these row shapes mirror packages/db/migrations/*.sql exactly.
//
// Numeric-column convention: PostgreSQL `numeric` columns (yes_price, best_bid,
// best_ask, depth_usd) come back from pg as strings to avoid float precision
// loss — we return them AS-IS (string | null). Callers parse at the edge where
// they do math. `integer`/`real` columns come back as JS numbers.
import type pg from 'pg';
import { getPool } from './index.js';

// A Pool or a checked-out client — lets callers run helpers inside their own
// transaction when needed.
export type Queryable = pg.Pool | pg.PoolClient;

export interface MarketRow {
  id: string;
  polymarket_market_id: string;
  slug: string | null;
  title: string;
  category: 'sports' | 'geopolitics' | 'crypto';
  status: 'active' | 'paused' | 'resolved';
  thresholds: Record<string, unknown>;
  game_slug: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MarketOutcomeRow {
  id: string;
  name: string;
  token_id: string;
  side: string | null;
}

export interface WatchedMarket extends MarketRow {
  outcomes: MarketOutcomeRow[];
}

export interface NewMarketSnapshot {
  market_id: string;
  outcome_id: string;
  yes_price: number | string | null;
  best_bid: number | string | null;
  best_ask: number | string | null;
  spread_bps: number | null;
  depth_usd: number | string | null;
  provider: string; // e.g. 'clob_ws' | 'clob_rest'
  provider_ref?: string | null;
  raw_payload: unknown;
  observed_at: Date | string;
  mode?: 'live' | 'replay';
  replay_run_id?: string | null;
}

export interface NewEvidence {
  title: string | null;
  url: string | null;
  excerpt: string | null;
  content_hash: string | null;
  source_tier: string | null;
  published_at: Date | string | null; // Linkup often omits publishedAt — keep nullable
  retrieved_at: Date | string;
  relevance: number | null;
  confidence: number | null;
  raw_payload: unknown;
}

const MARKET_COLUMNS =
  'id, polymarket_market_id, slug, title, category, status, thresholds, game_slug, created_at, updated_at';

export async function getMarketByPolymarketId(
  polymarketMarketId: string,
  db: Queryable = getPool(),
): Promise<MarketRow | null> {
  const { rows } = await db.query<MarketRow>(
    `select ${MARKET_COLUMNS} from markets where polymarket_market_id = $1`,
    [polymarketMarketId],
  );
  return rows[0] ?? null;
}

export async function getMarketByGameSlug(
  gameSlug: string,
  db: Queryable = getPool(),
): Promise<MarketRow | null> {
  const { rows } = await db.query<MarketRow>(
    `select ${MARKET_COLUMNS} from markets where game_slug = $1`,
    [gameSlug],
  );
  return rows[0] ?? null;
}

// Active markets plus their outcomes, so the ingestor knows which CLOB token
// ids to subscribe to and which game slugs to watch on the sports feed.
export async function listActiveWatchedMarkets(
  db: Queryable = getPool(),
): Promise<WatchedMarket[]> {
  const { rows } = await db.query<WatchedMarket>(
    `select m.id, m.polymarket_market_id, m.slug, m.title, m.category, m.status,
            m.thresholds, m.game_slug, m.created_at, m.updated_at,
            coalesce(
              jsonb_agg(
                jsonb_build_object('id', o.id, 'name', o.name, 'token_id', o.token_id, 'side', o.side)
                order by o.token_id
              ) filter (where o.id is not null),
              '[]'::jsonb
            ) as outcomes
       from markets m
       left join market_outcomes o on o.market_id = m.id
      where m.status = 'active'
      group by m.id
      order by m.created_at`,
  );
  return rows;
}

export async function insertMarketSnapshot(
  s: NewMarketSnapshot,
  db: Queryable = getPool(),
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into market_snapshots
       (market_id, outcome_id, yes_price, best_bid, best_ask, spread_bps,
        depth_usd, provider, provider_ref, raw_payload, observed_at, mode, replay_run_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      s.market_id,
      s.outcome_id,
      s.yes_price,
      s.best_bid,
      s.best_ask,
      s.spread_bps,
      s.depth_usd,
      s.provider,
      s.provider_ref ?? null,
      JSON.stringify(s.raw_payload ?? null),
      s.observed_at,
      s.mode ?? 'live',
      s.replay_run_id ?? null,
    ],
  );
  return rows[0].id;
}

// Bulk insert of evidence rows for a single event; returns ids in input order.
export async function insertEvidence(
  eventId: string,
  evidenceRows: NewEvidence[],
  db: Queryable = getPool(),
): Promise<string[]> {
  if (evidenceRows.length === 0) return [];
  const params: unknown[] = [eventId];
  const tuples = evidenceRows.map((e) => {
    const base = params.length;
    params.push(
      e.title,
      e.url,
      e.excerpt,
      e.content_hash,
      e.source_tier,
      e.published_at,
      e.retrieved_at,
      e.relevance,
      e.confidence,
      JSON.stringify(e.raw_payload ?? null),
    );
    const placeholders = Array.from({ length: 10 }, (_, i) => `$${base + i + 1}`);
    return `($1, ${placeholders.join(', ')})`;
  });
  const { rows } = await db.query<{ id: string }>(
    `insert into evidence
       (event_id, title, url, excerpt, content_hash, source_tier,
        published_at, retrieved_at, relevance, confidence, raw_payload)
     values ${tuples.join(', ')}
     returning id`,
    params,
  );
  return rows.map((r) => r.id);
}
