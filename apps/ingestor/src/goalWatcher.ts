// Sports-WS goal watcher — the live event trigger (docs/POLYMARKET_INTEGRATION.md).
// Diffs scores from the Polymarket sports feed for watched game slugs, corroborates via
// Linkup FIRST, then posts a NormalizedEvent + inline evidence through the PUBLIC ingest
// contract (POST /v1/events — same path a replay or external webhook takes). The API
// inserts event + evidence + queued run in one transaction, so the Hermes orchestrator
// can never claim a run before its evidence is durable.

import { createHash } from 'node:crypto';
import type { IngestEvidenceItem, NormalizedEvent } from '@edge-desk/contracts';
import { clob, linkup, sports } from '@edge-desk/integrations';
import { insertMarketSnapshot, type WatchedMarket } from '@edge-desk/db';

const SPORTS_FEED_URL = 'wss://sports-api.polymarket.com/ws';

// Linkup allows 10 q/s org-wide — the tightest limit in the stack. Serialize calls.
let linkupChain: Promise<unknown> = Promise.resolve();
function enqueueLinkup<T>(fn: () => Promise<T>): Promise<T> {
  const next = linkupChain.then(fn, fn);
  linkupChain = next.catch(() => {});
  return next;
}

async function postEvent(
  event: NormalizedEvent & { evidence: IngestEvidenceItem[] },
): Promise<{ eventId: string; duplicate: boolean } | null> {
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

/** Feed payload itself is primary evidence (§4.5); Linkup corroboration rides alongside. */
async function buildEvidence(e: sports.ScoreChangeEvent): Promise<IngestEvidenceItem[]> {
  const feedRow: IngestEvidenceItem = {
    title: `Polymarket sports feed: ${e.homeTeam} vs ${e.awayTeam} ${e.score}`,
    url: SPORTS_FEED_URL,
    excerpt: `score ${e.prevScore} -> ${e.score} | period ${e.period ?? '?'} | elapsed ${e.elapsed ?? '?'} | status ${e.status}`,
    contentHash: createHash('sha256').update(JSON.stringify(e.raw)).digest('hex'),
    sourceTier: 'primary',
    publishedAt: e.receivedAt,
    retrievedAt: e.receivedAt,
    relevance: 1,
    confidence: 0.9,
    raw: e.raw,
  };

  if (!process.env.LINKUP_API_KEY) {
    console.warn('[goalWatcher] LINKUP_API_KEY not set — skipping corroboration');
    return [feedRow];
  }
  try {
    const query = `${e.homeTeam} vs ${e.awayTeam} ${e.score} ${e.league} live score`;
    const record = await enqueueLinkup(() =>
      linkup.fetchFreshEvidence(query, { depth: 'fast', maxResults: 5 }),
    );
    const corroboration = linkup.toEvidenceRows(query, record).map((r) => ({
      title: r.title,
      url: r.url,
      excerpt: r.excerpt,
      contentHash: r.contentHash,
      sourceTier: r.sourceTier,
      publishedAt: r.publishedAt,
      retrievedAt: r.retrievedAt,
      relevance: r.relevance,
      confidence: record.confidence,
      raw: r.raw,
    }));
    return [feedRow, ...corroboration];
  } catch (err) {
    console.error('[goalWatcher] linkup corroboration failed (event ships with feed evidence)', err);
    return [feedRow];
  }
}

/**
 * Post-event REST snapshot, taken BEFORE the event is posted. Quiet order books can go
 * minutes between CLOB-WS ticks, so without this the orchestrator can claim the run
 * before any snapshot with observed_at > occurred_at exists ("missing post-event
 * snapshot" -> hard risk flag). Capturing via REST first guarantees one.
 */
async function snapshotNow(market: WatchedMarket): Promise<void> {
  await Promise.all(
    market.outcomes.map(async (outcome) => {
      try {
        const { snapshot, raw } = await clob.fetchSnapshot(outcome.token_id, {
          marketId: market.polymarket_market_id,
          outcome: outcome.name,
        });
        await insertMarketSnapshot({
          market_id: market.id,
          outcome_id: outcome.id,
          yes_price: snapshot.yesPrice,
          best_bid: snapshot.bestBid,
          best_ask: snapshot.bestAsk,
          spread_bps: snapshot.spreadBps,
          depth_usd: snapshot.depthUsd,
          provider: 'clob_rest',
          provider_ref: outcome.token_id,
          raw_payload: raw,
          observed_at: snapshot.observedAt,
        });
      } catch (err) {
        console.error(`[goalWatcher] post-event snapshot failed for ${outcome.name}`, err);
      }
    }),
  );
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
      void (async () => {
        const [evidence] = await Promise.all([buildEvidence(e), snapshotNow(market)]);
        const accepted = await postEvent({
          sourceEventId: `${e.slug}-${e.score}`, // stable per score line: dedupe for free
          source: 'polymarket_sports_ws',
          marketId: market.polymarket_market_id,
          category: 'sports',
          eventType: 'score_change',
          eventText: `${e.homeTeam} vs ${e.awayTeam} — ${e.prevScore ?? '?'} -> ${e.score} (${e.period ?? ''} ${e.elapsed ?? ''})`.trim(),
          occurredAt: e.receivedAt, // feed carries no per-event timestamp; receipt time is closest
          sourceUrl: SPORTS_FEED_URL,
          data: { ...e, raw: undefined },
          evidence,
        });
        if (accepted) {
          console.log(
            `[goalWatcher] event ${accepted.eventId} ${accepted.duplicate ? '(duplicate)' : `queued with ${evidence.length} evidence rows`}`,
          );
        }
      })();
    },
    onStatus: (e) => console.log(`[goalWatcher] ${e.slug}: status ${e.prevStatus} -> ${e.status} (live=${e.live} ended=${e.ended})`),
  });

  console.log(`[goalWatcher] watching ${bySlug.size} game slug(s): ${[...bySlug.keys()].join(', ')}`);
  return unsubscribe;
}
