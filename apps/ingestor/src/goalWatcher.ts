// Sports-WS goal watcher — the live event trigger (docs/POLYMARKET_INTEGRATION.md).
// Diffs scores from the Polymarket sports feed for watched game slugs, posts a
// NormalizedEvent through the PUBLIC ingest contract (POST /v1/events — same path a
// replay or external webhook takes), then corroborates the accepted event via Linkup
// and persists evidence rows. Corroboration always runs after the 202, never in the
// API request path.

import { createHash } from 'node:crypto';
import type { NormalizedEvent } from '@edge-desk/contracts';
import { linkup, sports } from '@edge-desk/integrations';
import { insertEvidence, type WatchedMarket } from '@edge-desk/db';

const SPORTS_FEED_URL = 'wss://sports-api.polymarket.com/ws';

// Linkup allows 10 q/s org-wide — the tightest limit in the stack. Serialize calls.
let linkupChain: Promise<unknown> = Promise.resolve();
function enqueueLinkup<T>(fn: () => Promise<T>): Promise<T> {
  const next = linkupChain.then(fn, fn);
  linkupChain = next.catch(() => {});
  return next;
}

async function postEvent(event: NormalizedEvent): Promise<{ eventId: string; duplicate: boolean } | null> {
  const url = `${process.env.INGEST_API_URL ?? 'http://localhost:3000'}/v1/events`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      if (res.status === 202) return (await res.json()) as { eventId: string; duplicate: boolean };
      console.error(`[goalWatcher] ingest rejected (${res.status}):`, await res.text());
      return null; // 4xx: retrying the same payload cannot help
    } catch (err) {
      console.error(`[goalWatcher] ingest POST failed (attempt ${attempt}/3)`, err);
      await new Promise((r) => setTimeout(r, attempt * 1_000));
    }
  }
  return null;
}

async function corroborate(eventId: string, e: sports.ScoreChangeEvent): Promise<void> {
  const feedRow = {
    title: `Polymarket sports feed: ${e.homeTeam} vs ${e.awayTeam} ${e.score}`,
    url: SPORTS_FEED_URL,
    excerpt: `score ${e.prevScore} -> ${e.score} | period ${e.period} | elapsed ${e.elapsed} | status ${e.status}`,
    content_hash: createHash('sha256').update(JSON.stringify(e.raw)).digest('hex'),
    source_tier: 'primary', // §4.5: a trusted live event payload is primary evidence
    published_at: e.receivedAt,
    retrieved_at: e.receivedAt,
    relevance: 1,
    confidence: 0.9,
    raw_payload: e.raw,
  };

  let corroborationRows: Parameters<typeof insertEvidence>[1] = [];
  if (process.env.LINKUP_API_KEY) {
    try {
      const query = `${e.homeTeam} vs ${e.awayTeam} ${e.score} ${e.league} live score goal`;
      const record = await enqueueLinkup(() =>
        linkup.fetchFreshEvidence(query, { depth: 'fast', maxResults: 5 }),
      );
      corroborationRows = linkup.toEvidenceRows(query, record).map((r) => ({
        title: r.title,
        url: r.url,
        excerpt: r.excerpt,
        content_hash: r.contentHash,
        source_tier: r.sourceTier,
        published_at: r.publishedAt,
        retrieved_at: r.retrievedAt,
        relevance: r.relevance,
        confidence: record.confidence,
        raw_payload: r.raw,
      }));
    } catch (err) {
      console.error('[goalWatcher] linkup corroboration failed (event keeps feed evidence)', err);
    }
  } else {
    console.warn('[goalWatcher] LINKUP_API_KEY not set — skipping corroboration');
  }

  const ids = await insertEvidence(eventId, [feedRow, ...corroborationRows]);
  console.log(`[goalWatcher] stored ${ids.length} evidence rows for event ${eventId}`);
}

export function startGoalWatcher(watched: WatchedMarket[]): () => void {
  const bySlug = new Map<string, WatchedMarket>();
  for (const market of watched) {
    if (market.game_slug && market.status === 'active') bySlug.set(market.game_slug, market);
  }
  if (bySlug.size === 0) {
    console.log('[goalWatcher] no active markets with game_slug — sports feed not started');
    return () => {};
  }

  const unsubscribe = sports.subscribeSportsFeed([...bySlug.keys()], {
    onScoreChange: (e) => {
      const market = bySlug.get(e.slug);
      if (!market) return;
      const event: NormalizedEvent = {
        sourceEventId: `${e.slug}-${e.score}`, // stable per score line: dedupe for free
        source: 'polymarket_sports_ws',
        marketId: market.polymarket_market_id,
        category: 'sports',
        eventType: 'score_change',
        eventText: `${e.homeTeam} vs ${e.awayTeam} — ${e.prevScore ?? '?'} -> ${e.score} (${e.period ?? ''} ${e.elapsed ?? ''})`.trim(),
        occurredAt: e.receivedAt, // feed carries no per-event timestamp; receipt time is closest
        sourceUrl: SPORTS_FEED_URL,
        data: { ...e, raw: undefined },
      };
      void (async () => {
        const accepted = await postEvent(event);
        if (accepted && !accepted.duplicate) await corroborate(accepted.eventId, e);
      })();
    },
    onStatus: (e) => console.log(`[goalWatcher] ${e.slug}: status ${e.status} (live=${e.live} ended=${e.ended})`),
  });

  console.log(`[goalWatcher] watching ${bySlug.size} game slug(s): ${[...bySlug.keys()].join(', ')}`);
  return unsubscribe;
}
