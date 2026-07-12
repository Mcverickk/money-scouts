// Polymarket CLOB adapter — prices, spread, depth.
// Per docs/TECH_ARCHITECTURE.md §2.1: WebSocket for live watched prices; REST for
// startup snapshots, recovery, manual checks, and +2/+3/+5 minute follow-ups.
// Base URL: POLYMARKET_CLOB_URL. Endpoint audit: docs/POLYMARKET_INTEGRATION.md.

import WebSocket from 'ws';
import type { MarketSnapshot } from '@edge-desk/contracts';

function clobUrl(): string {
  return process.env.POLYMARKET_CLOB_URL ?? 'https://clob.polymarket.com';
}

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Only levels within this many dollars of the BBO count toward depthUsd. */
const DEPTH_BAND_USD = 0.02;

export interface SnapshotMeta {
  marketId?: string;
  outcome?: string;
}

/** REST/WS both emit this pair: normalized snapshot + the provider payload it came from. */
export interface SnapshotResult {
  snapshot: MarketSnapshot;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Book math (shared by REST and WS paths)
// ---------------------------------------------------------------------------

interface BookLevels {
  bids: Map<string, number>; // price -> size (both parsed from provider strings)
  asks: Map<string, number>;
}

interface BookStats {
  bestBid: number;
  bestAsk: number;
  yesPrice: number;
  spreadBps: number;
  depthUsd: number;
}

/**
 * Deterministic top-of-book math. Best bid/ask are computed as max(bid)/min(ask)
 * rather than trusting array order (docs and observed payloads disagree on sort
 * direction). Empty sides fall back to the price bounds of a binary market
 * (bid 0 / ask 1). depthUsd = Σ price×size over BOTH sides for levels within
 * DEPTH_BAND_USD ($0.02) of that side's best price.
 */
function computeBookStats(book: BookLevels): BookStats {
  let bestBid = 0;
  for (const price of book.bids.keys()) {
    const p = Number(price);
    if (p > bestBid) bestBid = p;
  }
  let bestAsk = 1;
  let sawAsk = false;
  for (const price of book.asks.keys()) {
    const p = Number(price);
    if (!sawAsk || p < bestAsk) bestAsk = p;
    sawAsk = true;
  }

  let depthUsd = 0;
  for (const [price, size] of book.bids) {
    const p = Number(price);
    if (bestBid - p <= DEPTH_BAND_USD) depthUsd += p * size;
  }
  for (const [price, size] of book.asks) {
    const p = Number(price);
    if (p - bestAsk <= DEPTH_BAND_USD) depthUsd += p * size;
  }

  return {
    bestBid,
    bestAsk,
    yesPrice: round6((bestBid + bestAsk) / 2),
    spreadBps: Math.round((bestAsk - bestBid) * 10_000),
    depthUsd: Math.round(depthUsd * 100) / 100,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function statsToSnapshot(
  tokenId: string,
  stats: BookStats,
  meta: SnapshotMeta,
  observedAt: string,
): MarketSnapshot {
  return {
    marketId: meta.marketId ?? '',
    outcome: meta.outcome ?? '',
    tokenId,
    yesPrice: stats.yesPrice,
    bestBid: stats.bestBid,
    bestAsk: stats.bestAsk,
    spreadBps: stats.spreadBps,
    depthUsd: stats.depthUsd,
    observedAt,
  };
}

interface RawBookLevel {
  price: string;
  size: string;
}

interface RawBook {
  market?: string;
  asset_id?: string;
  bids?: RawBookLevel[];
  asks?: RawBookLevel[];
}

function levelsFromRaw(raw: RawBook): BookLevels {
  const bids = new Map<string, number>();
  const asks = new Map<string, number>();
  for (const level of raw.bids ?? []) bids.set(level.price, Number(level.size));
  for (const level of raw.asks ?? []) asks.set(level.price, Number(level.size));
  return { bids, asks };
}

async function fetchBook(tokenId: string): Promise<RawBook> {
  const res = await fetch(`${clobUrl()}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!res.ok) {
    throw new Error(`CLOB GET /book failed for token ${tokenId}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RawBook;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** One-off REST snapshot for a single outcome token (baseline, recovery, outcome checks). */
export async function fetchSnapshot(tokenId: string, meta: SnapshotMeta = {}): Promise<SnapshotResult> {
  const raw = await fetchBook(tokenId);
  const stats = computeBookStats(levelsFromRaw(raw));
  return {
    snapshot: statsToSnapshot(tokenId, stats, meta, new Date().toISOString()),
    raw,
  };
}

/**
 * USD depth available near the top of book, capped at `notionalUsd`. Walks bids and
 * asks from the BBO outward, accumulating price×size across both sides, and stops
 * once `notionalUsd` is covered. A return value equal to `notionalUsd` means the
 * book can absorb that notional; anything less is all the depth there is.
 */
export async function fetchDepthUsd(tokenId: string, notionalUsd: number): Promise<number> {
  const raw = await fetchBook(tokenId);
  const bids = (raw.bids ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((a, b) => b.price - a.price); // best bid first
  const asks = (raw.asks ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .sort((a, b) => a.price - b.price); // best ask first

  let accumulated = 0;
  const maxLevels = Math.max(bids.length, asks.length);
  for (let i = 0; i < maxLevels && accumulated < notionalUsd; i++) {
    if (i < bids.length) accumulated += bids[i].price * bids[i].size;
    if (i < asks.length) accumulated += asks[i].price * asks[i].size;
  }
  return Math.round(Math.min(accumulated, notionalUsd) * 100) / 100;
}

export interface PricePoint {
  ts: number; // unix seconds
  price: number;
}

/**
 * Historical prices at 1-minute fidelity via GET /prices-history?market=<tokenId>.
 * This is baseline recovery: reconstructing a pre-event price when live capture
 * missed it (docs/POLYMARKET_INTEGRATION.md, "CLOB REST — snapshots and baseline recovery").
 */
export async function fetchPriceHistory(
  tokenId: string,
  startTsSec: number,
  endTsSec?: number,
): Promise<PricePoint[]> {
  const params = new URLSearchParams({
    market: tokenId,
    fidelity: '1',
    startTs: String(startTsSec),
  });
  if (endTsSec !== undefined) params.set('endTs', String(endTsSec));

  const res = await fetch(`${clobUrl()}/prices-history?${params.toString()}`);
  if (!res.ok) {
    throw new Error(
      `CLOB GET /prices-history failed for token ${tokenId}: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { history?: Array<{ t: number; p: number }> };
  return (body.history ?? []).map((point) => ({ ts: point.t, price: point.p }));
}

// ---------------------------------------------------------------------------
// WebSocket — live watched prices
// ---------------------------------------------------------------------------

export interface SubscribeMarketOpts {
  /** Fired with the affected token IDs (filtered to this subscription) on `market_resolved`. */
  onMarketResolved?: (tokenIds: string[]) => void;
}

interface WsPriceChange {
  asset_id?: string;
  price?: string;
  size?: string;
  side?: 'BUY' | 'SELL';
  best_bid?: string;
  best_ask?: string;
}

interface WsMessage {
  event_type?: string;
  asset_id?: string;
  market?: string;
  bids?: RawBookLevel[];
  asks?: RawBookLevel[];
  price_changes?: WsPriceChange[];
  best_bid?: string;
  best_ask?: string;
  assets_ids?: string[];
}

const WS_HEARTBEAT_MS = 10_000; // docs: send "PING" every 10s, server replies "PONG"
const WS_BACKOFF_BASE_MS = 1_000;
const WS_BACKOFF_MAX_MS = 30_000;

/**
 * Live market-channel subscription for watched tokens. Maintains per-token book
 * state from `book` (full refresh) and `price_change` (level deltas; size "0"
 * removes a level), and emits a normalized `{ snapshot, raw }` whenever the
 * top-of-book stats meaningfully change. `snapshot.marketId` carries the CLOB
 * condition ID from the feed (callers map it to their own market rows).
 * Auto-reconnects with capped exponential backoff. Returns an unsubscribe fn
 * that closes cleanly (no reconnect afterwards).
 */
export function subscribeMarket(
  tokenIds: string[],
  onSnapshot: (update: SnapshotResult) => void,
  opts: SubscribeMarketOpts = {},
): () => void {
  const watched = new Set(tokenIds);
  const books = new Map<string, BookLevels>(); // tokenId -> book state
  const conditionIds = new Map<string, string>(); // tokenId -> CLOB condition id
  const lastEmitted = new Map<string, string>(); // tokenId -> stats fingerprint

  let ws: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function emitIfChanged(tokenId: string, raw: unknown): void {
    const book = books.get(tokenId);
    if (!book) return;
    const stats = computeBookStats(book);
    const fingerprint = `${stats.bestBid}|${stats.bestAsk}|${stats.depthUsd}`;
    if (lastEmitted.get(tokenId) === fingerprint) return;
    lastEmitted.set(tokenId, fingerprint);
    const snapshot = statsToSnapshot(
      tokenId,
      stats,
      { marketId: conditionIds.get(tokenId) },
      new Date().toISOString(),
    );
    onSnapshot({ snapshot, raw });
  }

  function handleMessage(msg: WsMessage): void {
    switch (msg.event_type) {
      case 'book': {
        const tokenId = msg.asset_id;
        if (!tokenId || !watched.has(tokenId)) return;
        books.set(tokenId, levelsFromRaw(msg));
        if (msg.market) conditionIds.set(tokenId, msg.market);
        emitIfChanged(tokenId, msg);
        return;
      }
      case 'price_change': {
        const touched = new Set<string>();
        for (const change of msg.price_changes ?? []) {
          const tokenId = change.asset_id;
          if (!tokenId || !watched.has(tokenId) || !change.price) continue;
          let book = books.get(tokenId);
          if (!book) {
            book = { bids: new Map(), asks: new Map() };
            books.set(tokenId, book);
          }
          if (msg.market) conditionIds.set(tokenId, msg.market);
          const side = change.side === 'BUY' ? book.bids : book.asks;
          const size = Number(change.size ?? '0');
          if (size === 0) side.delete(change.price);
          else side.set(change.price, size);
          touched.add(tokenId);
        }
        for (const tokenId of touched) emitIfChanged(tokenId, msg);
        return;
      }
      case 'best_bid_ask': {
        // Authoritative BBO push (custom_feature_enabled). Reconcile our book:
        // drop any stale levels better than the reported best on each side.
        const tokenId = msg.asset_id;
        if (!tokenId || !watched.has(tokenId)) return;
        const book = books.get(tokenId);
        if (!book || msg.best_bid === undefined || msg.best_ask === undefined) return;
        const bestBid = Number(msg.best_bid);
        const bestAsk = Number(msg.best_ask);
        for (const price of [...book.bids.keys()]) {
          if (Number(price) > bestBid) book.bids.delete(price);
        }
        for (const price of [...book.asks.keys()]) {
          if (Number(price) < bestAsk) book.asks.delete(price);
        }
        if (msg.market) conditionIds.set(tokenId, msg.market);
        emitIfChanged(tokenId, msg);
        return;
      }
      case 'market_resolved': {
        const resolved = (msg.assets_ids ?? []).filter((id) => watched.has(id));
        if (resolved.length > 0) opts.onMarketResolved?.(resolved);
        return;
      }
      default:
        return; // last_trade_price, tick_size_change, new_market: not needed here
    }
  }

  function connect(): void {
    if (closed) return;
    ws = new WebSocket(CLOB_WS_URL);

    ws.on('open', () => {
      attempts = 0;
      // Force a fresh emit from the post-(re)connect `book` refresh even if the
      // top of book did not move while we were disconnected.
      lastEmitted.clear();
      ws?.send(
        JSON.stringify({ assets_ids: tokenIds, type: 'market', custom_feature_enabled: true }),
      );
      heartbeat = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send('PING');
      }, WS_HEARTBEAT_MS);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const text = data.toString();
      if (text === 'PONG' || text === 'PING' || text === 'pong' || text === 'ping') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // non-JSON frame; ignore
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const msg of messages) {
        if (msg && typeof msg === 'object') handleMessage(msg as WsMessage);
      }
    });

    ws.on('error', () => {
      // 'close' always follows; reconnect is handled there.
    });

    ws.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      ws = null;
      if (closed) return;
      const delay = Math.min(WS_BACKOFF_BASE_MS * 2 ** attempts, WS_BACKOFF_MAX_MS);
      attempts += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  connect();

  return () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    heartbeat = null;
    reconnectTimer = null;
    ws?.close();
    ws = null;
  };
}
