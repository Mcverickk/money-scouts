// Polymarket Gamma adapter — market/event metadata and outcome token ID resolution.
// Base URL: POLYMARKET_GAMMA_URL. See docs/TECH_ARCHITECTURE.md §4.4.

export interface GammaMarket {
  polymarketMarketId: string;
  slug: string;
  title: string;
  outcomes: Array<{ name: string; tokenId: string }>;
}

/** Resolve a market by slug or ID so the operator can register it with mapped token IDs. */
export async function resolveMarket(_slugOrId: string): Promise<GammaMarket> {
  throw new Error('not implemented: gamma.resolveMarket');
}
