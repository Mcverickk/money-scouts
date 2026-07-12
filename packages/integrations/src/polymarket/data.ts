// Polymarket Data API adapter — optional trade/activity reads (e.g. big-wallet flows).
// Flagged in docs/README.md as the highest-risk task of the sprint: spike before committing.
// Base URL: POLYMARKET_DATA_URL.

export interface TradeActivity {
  tokenId: string;
  sizeUsd: number;
  side: 'buy' | 'sell';
  timestamp: string;
}

export async function fetchRecentActivity(_tokenId: string): Promise<TradeActivity[]> {
  throw new Error('not implemented: polymarketData.fetchRecentActivity');
}
