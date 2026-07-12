// CLOB-WS snapshot recorder — the pre-event baseline supply (docs/TECH_ARCHITECTURE.md §4.4).
// Subscribes to the market channel for every active market's outcome tokens and writes
// throttled market_snapshots rows. Without this stream the matcher has no trustworthy
// baseline and must return needs_review.

import { clob } from '@edge-desk/integrations';
import { getPool, insertMarketSnapshot, type WatchedMarket } from '@edge-desk/db';

const WRITE_INTERVAL_MS = 1_000; // at most one row per token per second

interface TokenRef {
  marketId: string;
  outcomeId: string;
}

export function startSnapshotRecorder(watched: WatchedMarket[]): () => void {
  const tokenRefs = new Map<string, TokenRef>();
  for (const market of watched) {
    for (const outcome of market.outcomes) {
      tokenRefs.set(outcome.token_id, { marketId: market.id, outcomeId: outcome.id });
    }
  }
  if (tokenRefs.size === 0) return () => {};

  const lastWriteAt = new Map<string, number>();

  const unsubscribe = clob.subscribeMarket(
    [...tokenRefs.keys()],
    ({ snapshot, raw }) => {
      const ref = tokenRefs.get(snapshot.tokenId);
      if (!ref) return;
      const now = Date.now();
      if (now - (lastWriteAt.get(snapshot.tokenId) ?? 0) < WRITE_INTERVAL_MS) return;
      lastWriteAt.set(snapshot.tokenId, now);
      insertMarketSnapshot({
        market_id: ref.marketId,
        outcome_id: ref.outcomeId,
        yes_price: snapshot.yesPrice,
        best_bid: snapshot.bestBid,
        best_ask: snapshot.bestAsk,
        spread_bps: snapshot.spreadBps,
        depth_usd: snapshot.depthUsd,
        provider: 'clob_ws',
        provider_ref: snapshot.tokenId,
        raw_payload: raw,
        observed_at: snapshot.observedAt,
      }).catch((err) => console.error('[snapshotRecorder] insert failed', err));
    },
    {
      onMarketResolved: (resolvedTokenIds) => {
        const marketIds = [
          ...new Set(resolvedTokenIds.map((t) => tokenRefs.get(t)?.marketId).filter(Boolean)),
        ];
        if (marketIds.length === 0) return;
        getPool()
          .query(`update markets set status = 'resolved', updated_at = now() where id = any($1)`, [
            marketIds,
          ])
          .then(() => console.log('[snapshotRecorder] marked resolved:', marketIds))
          .catch((err) => console.error('[snapshotRecorder] resolve update failed', err));
      },
    },
  );

  console.log(`[snapshotRecorder] watching ${tokenRefs.size} tokens across ${watched.length} markets`);
  return unsubscribe;
}
