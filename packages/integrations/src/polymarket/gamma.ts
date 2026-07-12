// Polymarket Gamma adapter — market/event metadata and outcome token ID resolution.
// Base URL: POLYMARKET_GAMMA_URL. See docs/TECH_ARCHITECTURE.md §4.4 and
// docs/POLYMARKET_INTEGRATION.md ("Gamma — discovery and token mapping").

export interface GammaMarket {
  polymarketMarketId: string;
  slug: string;
  title: string;
  outcomes: Array<{ name: string; tokenId: string }>;
}

function gammaUrl(): string {
  return process.env.POLYMARKET_GAMMA_URL ?? 'https://gamma-api.polymarket.com';
}

/**
 * Gamma serializes `outcomes` and `clobTokenIds` as JSON *strings* on market reads
 * (e.g. `"[\"Yes\", \"No\"]"`); some listing shapes return real arrays. Accept both.
 * Returns null when the field is null/undefined or unparseable.
 */
function parseJsonStringArray(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface RawGammaMarket {
  id?: string | number;
  slug?: string;
  question?: string;
  title?: string;
  outcomes?: unknown;
  clobTokenIds?: unknown;
}

/**
 * Resolve a market by slug or numeric Gamma ID so the operator can register it with
 * mapped CLOB token IDs. Tries `GET /markets?slug=<slug>` first, then `GET /markets/<id>`.
 * Throws if the market cannot be found or has no `clobTokenIds` (unmapped / AMM-only market).
 */
export async function resolveMarket(slugOrId: string): Promise<GammaMarket> {
  let market: RawGammaMarket | undefined;

  const bySlug = await fetch(`${gammaUrl()}/markets?slug=${encodeURIComponent(slugOrId)}`);
  if (bySlug.ok) {
    const body: unknown = await bySlug.json();
    if (Array.isArray(body) && body.length > 0) market = body[0] as RawGammaMarket;
  }

  if (!market) {
    const byId = await fetch(`${gammaUrl()}/markets/${encodeURIComponent(slugOrId)}`);
    if (byId.ok) {
      const body: unknown = await byId.json();
      if (body && typeof body === 'object' && 'id' in body) market = body as RawGammaMarket;
    }
  }

  if (!market || market.id == null) {
    throw new Error(
      `Polymarket market not found for "${slugOrId}" (tried Gamma /markets?slug= and /markets/{id})`,
    );
  }

  const tokenIds = parseJsonStringArray(market.clobTokenIds);
  if (!tokenIds || tokenIds.length === 0) {
    throw new Error(
      `Gamma market "${slugOrId}" (id=${String(market.id)}) has no clobTokenIds — ` +
        'it is not mapped to CLOB outcome tokens and cannot be watched.',
    );
  }

  const outcomeNames = parseJsonStringArray(market.outcomes);
  if (!outcomeNames || outcomeNames.length !== tokenIds.length) {
    throw new Error(
      `Gamma market "${slugOrId}" (id=${String(market.id)}) has ${String(outcomeNames?.length ?? 0)} ` +
        `outcomes but ${String(tokenIds.length)} clobTokenIds — cannot zip outcome→token mapping.`,
    );
  }

  return {
    polymarketMarketId: String(market.id),
    slug: market.slug ?? '',
    title: market.question ?? market.title ?? '',
    // outcomes and clobTokenIds are index-aligned per Polymarket docs.
    outcomes: outcomeNames.map((name, i) => ({ name, tokenId: tokenIds[i] })),
  };
}
