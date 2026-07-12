// Polymarket Sports WebSocket adapter — the live-score event trigger.
// wss://sports-api.polymarket.com/ws is a public firehose of all active games
// (no auth, no subscribe message); we filter client-side by slug and derive
// "goal" events by diffing `score` across messages. Downstream builds its
// idempotency key as `${slug}-${score}`, so `score` is passed through verbatim.
// See docs/POLYMARKET_INTEGRATION.md ("Sports WebSocket — the event trigger").

import WebSocket from 'ws';

function sportsWsUrl(): string {
  return process.env.POLYMARKET_SPORTS_WS_URL ?? 'wss://sports-api.polymarket.com/ws';
}

/**
 * `sport_result` message shape (docs: market-data/websocket/sports).
 * SCHEMA DEVIATION observed live (2026-07-12): the documented top-level `slug`
 * (`{league}-{team1}-{team2}-{date}`) is ABSENT from real feed messages. When
 * missing, this adapter keys games by a synthesized `{leagueAbbreviation}-{gameId}`
 * slug instead — stable per game, so downstream `${slug}-${score}` dedupe still holds.
 */
export interface SportResultMessage {
  gameId: number;
  leagueAbbreviation: string;
  slug?: string; // documented but missing from live messages; see note above
  homeTeam: string;
  awayTeam: string;
  status: string; // sport-specific, e.g. Scheduled | InProgress | Break | Final | ...
  score: string; // verbatim feed format, e.g. "1-0" or "000-000|2-0|Bo3"
  period?: string;
  elapsed?: string;
  live: boolean;
  ended: boolean;
  finished_timestamp?: string; // ISO, only present when ended
  turn?: string; // possession, NFL/CFB only
}

export interface ScoreChangeEvent {
  /** Feed slug when present, else synthesized `{league}-{gameId}` (see SportResultMessage). */
  slug: string;
  gameId: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  prevScore: string;
  /** Verbatim from the feed — downstream dedupe key is `${slug}-${score}`. */
  score: string;
  period?: string;
  elapsed?: string;
  status: string;
  live: boolean;
  ended: boolean;
  receivedAt: string; // ISO now
  raw: unknown;
}

export interface StatusChangeEvent {
  slug: string;
  gameId: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  prevStatus: string;
  status: string;
  score: string;
  period?: string;
  elapsed?: string;
  live: boolean;
  ended: boolean;
  receivedAt: string;
  raw: unknown;
}

export interface SportsFeedHandlers {
  onScoreChange: (event: ScoreChangeEvent) => void;
  /** Status transitions (match went live / halftime / ended). */
  onStatus?: (event: StatusChangeEvent) => void;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Server pings every 5s; if nothing arrives for this long the socket is dead. */
const LIVENESS_TIMEOUT_MS = 30_000;

/**
 * Subscribe to the Polymarket sports firehose, filtered to `watchedSlugs`
 * (or every game with `'all'`). Emits `onScoreChange` when a watched game's
 * `score` differs from the last one seen for that slug, and `onStatus` on
 * status transitions. First sighting of a game only seeds the cache — it is
 * not a change. The per-slug caches survive reconnects, so a goal emitted
 * before a disconnect is not re-emitted after.
 *
 * Heartbeat: the server sends a text-frame "ping" every 5s and expects "pong"
 * within 10s; protocol-level pings are answered too (ws autoPong). Reconnects
 * with capped exponential backoff. Returns an unsubscribe fn.
 */
export function subscribeSportsFeed(
  watchedSlugs: string[] | 'all',
  handlers: SportsFeedHandlers,
): () => void {
  const watched = watchedSlugs === 'all' ? 'all' : new Set(watchedSlugs);
  // Both caches intentionally live outside connect() so reconnects do not
  // re-emit goals/transitions already delivered.
  const lastScore = new Map<string, string>();
  const lastStatus = new Map<string, string>();

  let ws: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let livenessTimer: NodeJS.Timeout | null = null;

  function armLivenessTimer(): void {
    if (livenessTimer) clearTimeout(livenessTimer);
    livenessTimer = setTimeout(() => {
      // No frames (not even server pings) for too long: force a reconnect.
      ws?.terminate();
    }, LIVENESS_TIMEOUT_MS);
  }

  function handleSportResult(msg: SportResultMessage, raw: unknown): void {
    // Live messages omit the documented `slug`; synthesize a stable per-game key.
    const slug = msg.slug ?? `${msg.leagueAbbreviation}-${String(msg.gameId)}`;
    if (watched !== 'all' && !watched.has(slug)) return;
    const receivedAt = new Date().toISOString();

    const prevScore = lastScore.get(slug);
    if (typeof msg.score === 'string') {
      if (prevScore !== undefined && prevScore !== msg.score) {
        handlers.onScoreChange({
          slug,
          gameId: msg.gameId,
          league: msg.leagueAbbreviation,
          homeTeam: msg.homeTeam,
          awayTeam: msg.awayTeam,
          prevScore,
          score: msg.score,
          period: msg.period,
          elapsed: msg.elapsed,
          status: msg.status,
          live: msg.live,
          ended: msg.ended,
          receivedAt,
          raw,
        });
      }
      lastScore.set(slug, msg.score);
    }

    const prevStatus = lastStatus.get(slug);
    if (typeof msg.status === 'string') {
      if (prevStatus !== undefined && prevStatus !== msg.status) {
        handlers.onStatus?.({
          slug,
          gameId: msg.gameId,
          league: msg.leagueAbbreviation,
          homeTeam: msg.homeTeam,
          awayTeam: msg.awayTeam,
          prevStatus,
          status: msg.status,
          score: msg.score,
          period: msg.period,
          elapsed: msg.elapsed,
          live: msg.live,
          ended: msg.ended,
          receivedAt,
          raw,
        });
      }
      lastStatus.set(slug, msg.status);
    }
  }

  function connect(): void {
    if (closed) return;
    // autoPong answers protocol-level pings; the documented heartbeat is a
    // text-frame "ping" handled in the message listener below.
    ws = new WebSocket(sportsWsUrl(), { autoPong: true });

    ws.on('open', () => {
      attempts = 0;
      armLivenessTimer();
    });

    ws.on('ping', () => {
      armLivenessTimer(); // pong itself is sent automatically (autoPong)
    });

    ws.on('message', (data: WebSocket.RawData) => {
      armLivenessTimer();
      const text = data.toString();
      if (text === 'ping') {
        ws?.send('pong');
        return;
      }
      if (text === 'pong') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // non-JSON frame; ignore
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const msg of messages) {
        if (
          msg &&
          typeof msg === 'object' &&
          typeof (msg as SportResultMessage).gameId === 'number' &&
          typeof (msg as SportResultMessage).leagueAbbreviation === 'string'
        ) {
          handleSportResult(msg as SportResultMessage, msg);
        }
      }
    });

    ws.on('error', () => {
      // 'close' always follows; reconnect is handled there.
    });

    ws.on('close', () => {
      if (livenessTimer) clearTimeout(livenessTimer);
      livenessTimer = null;
      ws = null;
      if (closed) return;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
      attempts += 1;
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (livenessTimer) clearTimeout(livenessTimer);
    reconnectTimer = null;
    livenessTimer = null;
    ws?.close();
    ws = null;
  };
}
