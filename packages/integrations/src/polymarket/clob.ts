// Polymarket CLOB adapter — prices, spread, depth.
// Per docs/TECH_ARCHITECTURE.md §2.1: WebSocket for live watched prices; REST for
// startup snapshots, recovery, manual checks, and +10/+20/+40 follow-ups.
// Base URL: POLYMARKET_CLOB_URL.

import type { MarketSnapshot } from '@edge-desk/contracts';

/** One-off REST snapshot for a single outcome token (baseline, recovery, outcome checks). */
export async function fetchSnapshot(_tokenId: string): Promise<MarketSnapshot> {
  throw new Error('not implemented: clob.fetchSnapshot');
}

/** Live market-channel subscription for watched tokens. Returns an unsubscribe fn. */
export function subscribeMarket(
  _tokenIds: string[],
  _onSnapshot: (snapshot: MarketSnapshot) => void,
): () => void {
  throw new Error('not implemented: clob.subscribeMarket');
}

/** Order-book depth in USD available within a configured notional. */
export async function fetchDepthUsd(_tokenId: string, _notionalUsd: number): Promise<number> {
  throw new Error('not implemented: clob.fetchDepthUsd');
}
