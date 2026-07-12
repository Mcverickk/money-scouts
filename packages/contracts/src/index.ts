// Shared contracts between the ingestion leg, the Hermes leg, and the matcher.
// These mirror the JSON examples in docs/TECH_ARCHITECTURE.md (§2.2, §4.2, §4.4, §4.5, §4.7)
// and docs/HERMES_MARKET_AGENT_CONTEXT.md. Changing a contract here changes the seam
// between owners — announce it before committing.

export type Category = 'sports' | 'geopolitics' | 'crypto';
export type Mode = 'live' | 'replay';
export type SignalDirection = 'yes_up' | 'yes_down';
export type MatcherAction = 'notify' | 'ignore' | 'needs_review';
export type Side = 'buy_yes' | 'buy_no';

/** Inbound trigger accepted by POST /v1/events (docs/TECH_ARCHITECTURE.md §4.2). */
export interface NormalizedEvent {
  sourceEventId: string;
  source: string;
  marketId: string;
  category: Category;
  eventType: string;
  eventText: string;
  occurredAt: string; // ISO timestamp from the source, distinct from receivedAt
  sourceUrl?: string;
  data?: Record<string, unknown>;
}

/** What every domain specialist returns, regardless of category (§2.2). */
export interface SpecialistSignal {
  category: Category;
  direction: SignalDirection;
  expectedMoveBps: number;
  confidence: number;
  summary: string;
  evidenceIds: string[];
  riskFlags: string[];
}

/** Normalized Polymarket snapshot from the shared adapter (§4.4). */
export interface MarketSnapshot {
  marketId: string;
  outcome: string;
  tokenId: string;
  yesPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  depthUsd: number;
  observedAt: string;
}

/** A single cited evidence item from the shared evidence adapter (§4.5). */
export interface EvidenceItem {
  title: string;
  url: string;
  /** Linkup-sourced evidence has null publishedAt unless parsed from content — retrievedAt is the authoritative clock (docs/LINKUP_INTEGRATION.md). */
  publishedAt: string | null;
  retrievedAt: string;
  relevance: number;
  sourceTier: 'primary' | 'secondary' | 'social';
}

export interface EvidenceRecord {
  eventSummary: string;
  evidence: EvidenceItem[];
  freshnessSeconds: number;
  confidence: number;
}

/** Immutable matcher output (§4.7). Only `notify` creates an alert row. */
export interface MatcherDecision {
  action: MatcherAction;
  side?: Side;
  confidence: number;
  expectedMoveBps: number;
  observedMoveBps: number;
  lagBps: number;
  reason: string;
  riskFlags: string[];
  evidenceIds: string[];
  baselineSnapshotId: string;
  currentSnapshotId: string;
  scoringPolicyVersion: string;
}

/** Future auto-trading boundary (§13) — emitted, never executed, by this codebase. */
export interface TradeIntent {
  intent: Side;
  marketId: string;
  outcomeTokenId: string;
  maxPrice: number;
  maxNotionalUsd: number;
  confidence: number;
  decisionId: string;
}
