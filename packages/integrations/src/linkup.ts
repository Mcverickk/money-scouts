// Linkup adapter — fresh evidence discovery shared by all domain specialists.
// Every cited fact keeps source URL, publishedAt, and retrievedAt (docs/TECH_ARCHITECTURE.md §4.5).
// Endpoint audit + freshness-gap notes: docs/LINKUP_INTEGRATION.md. Auth: LINKUP_API_KEY.
//
// Freshness caveat: Linkup search results carry NO publish timestamps ({name, url, content}
// only), so publishedAt is always null here and true freshness gating must key on the
// event→retrieval window — the `fromDate` request filter plus our own `retrievedAt` clock —
// never on claimed publish times (docs/LINKUP_INTEGRATION.md, "The freshness gap").

import { createHash } from 'node:crypto';
import type { EvidenceItem, EvidenceRecord } from '@edge-desk/contracts';

const LINKUP_SEARCH_URL = 'https://api.linkup.so/v1/search';

/**
 * Trusted sports outlets → sourceTier 'primary' by construction (docs/LINKUP_INTEGRATION.md
 * "Filters"). Exported so callers can pass it as `includeDomains` or extend it per category.
 */
export const PRIMARY_SPORTS_DOMAINS = [
  'bbc.com',
  'bbc.co.uk',
  'espn.com',
  'skysports.com',
  'reuters.com',
  'apnews.com',
  'theguardian.com',
] as const;

export interface FetchFreshEvidenceOpts {
  /** 'fast' (<1s, hot path) or 'standard' (1–3s, default). Never 'deep' in the alert path. */
  depth?: 'fast' | 'standard';
  maxResults?: number;
  includeDomains?: string[];
  /** ISO YYYY-MM-DD; defaults to today — date granularity is Linkup's maximum precision. */
  fromDate?: string;
  /**
   * Advisory only: Linkup returns no publish timestamps, so this cannot be enforced against
   * the API. Callers gate freshness on the event→retrieval window themselves.
   */
  maxAgeSeconds?: number;
}

/** Raw Linkup searchResults item (POST /v1/search, outputType=searchResults). */
export interface LinkupSearchResult {
  type: string;
  name: string;
  url: string;
  content: string;
  favicon?: string;
}

/** EvidenceItem plus the raw Linkup result so ingestion can persist without re-fetching. */
export interface LinkupEvidenceItem extends EvidenceItem {
  raw: LinkupSearchResult;
}

export interface LinkupEvidenceRecord extends EvidenceRecord {
  evidence: LinkupEvidenceItem[];
}

/** Shape the ingestor persists into the `evidence` table (excerpt + content_hash for audit). */
export interface EvidenceRow {
  title: string;
  url: string;
  excerpt: string;
  contentHash: string;
  sourceTier: EvidenceItem['sourceTier'];
  publishedAt: string | null;
  retrievedAt: string;
  relevance: number;
  raw: LinkupSearchResult;
}

const EXCERPT_MAX_CHARS = 500;

function requireApiKey(): string {
  const key = process.env.LINKUP_API_KEY;
  if (!key) {
    throw new Error(
      'LINKUP_API_KEY is not set — get a key from app.linkup.so and add it to .env',
    );
  }
  return key;
}

// Linkup validates `fromDate` as strictly before `toDate` (which defaults to today),
// so the freshest passing default is yesterday — date granularity is the API's maximum
// precision anyway (docs/LINKUP_INTEGRATION.md).
function yesterdayIsoDate(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function classifySourceTier(
  url: string,
  primaryDomains: readonly string[],
): EvidenceItem['sourceTier'] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'secondary';
  }
  const isPrimary = primaryDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  return isPrimary ? 'primary' : 'secondary';
}

/** Simple rank-based relevance: first result 1.0, linearly down to 0.5 for the last. */
function rankRelevance(index: number, count: number): number {
  if (count <= 1) return 1;
  return Number((1 - (0.5 * index) / (count - 1)).toFixed(3));
}

/**
 * Discover fresh evidence for a trigger via Linkup POST /v1/search
 * (depth per opts, outputType=searchResults, fromDate defaults to yesterday — see yesterdayIsoDate).
 *
 * - `publishedAt` is always null (Linkup returns none); `retrievedAt` is our clock.
 * - `freshnessSeconds` is the request→response wall time only. It is NOT evidence age:
 *   true freshness gating keys on the event→retrieval window (`fromDate` + `retrievedAt`),
 *   per the missing-publishedAt gap in docs/LINKUP_INTEGRATION.md.
 * - `confidence` is a placeholder heuristic, min(1, results/maxResults) — coverage, not
 *   truth. A domain specialist overwrites it after reading the evidence.
 */
export async function fetchFreshEvidence(
  query: string,
  opts?: FetchFreshEvidenceOpts,
): Promise<LinkupEvidenceRecord> {
  const apiKey = requireApiKey();
  const maxResults = opts?.maxResults ?? 8;

  const body: Record<string, unknown> = {
    q: query,
    depth: opts?.depth ?? 'standard',
    outputType: 'searchResults',
    fromDate: opts?.fromDate ?? yesterdayIsoDate(),
    maxResults,
  };
  if (opts?.includeDomains?.length) body.includeDomains = opts.includeDomains;

  const startedAtMs = Date.now();
  const response = await fetch(LINKUP_SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 401) {
      throw new Error(`Linkup 401: bad or missing API key (LINKUP_API_KEY). ${detail}`);
    }
    if (response.status === 429) {
      throw new Error(
        `Linkup 429: rate limit exceeded (10 q/s per org) OR insufficient credits — ` +
          `check the account's credit balance if 429s persist. ${detail}`,
      );
    }
    throw new Error(`Linkup search failed: HTTP ${response.status}. ${detail}`);
  }

  const payload = (await response.json()) as { results?: LinkupSearchResult[] };
  const retrievedAt = new Date().toISOString();
  const freshnessSeconds = Math.round((Date.now() - startedAtMs) / 1000);

  const results = (payload.results ?? []).filter((r) => r.type === 'text');
  const evidence: LinkupEvidenceItem[] = results.map((result, i) => ({
    title: result.name,
    url: result.url,
    publishedAt: null, // Linkup returns no publish timestamps — see module header.
    retrievedAt,
    relevance: rankRelevance(i, results.length),
    sourceTier: classifySourceTier(result.url, PRIMARY_SPORTS_DOMAINS),
    raw: result,
  }));

  return {
    eventSummary: query,
    evidence,
    freshnessSeconds,
    confidence: Math.min(1, evidence.length / maxResults),
  };
}

/**
 * Flatten a fetchFreshEvidence record into plain rows matching the `evidence` table
 * (excerpt truncated to ~500 chars, content_hash = sha256 of the full content) so the
 * ingestor can persist them without re-deriving anything.
 */
export function toEvidenceRows(
  _eventSummary: string,
  record: LinkupEvidenceRecord,
): EvidenceRow[] {
  return record.evidence.map((item) => ({
    title: item.title,
    url: item.url,
    excerpt: item.raw.content.slice(0, EXCERPT_MAX_CHARS),
    contentHash: createHash('sha256').update(item.raw.content).digest('hex'),
    sourceTier: item.sourceTier,
    publishedAt: item.publishedAt,
    retrievedAt: item.retrievedAt,
    relevance: item.relevance,
    raw: item.raw,
  }));
}
