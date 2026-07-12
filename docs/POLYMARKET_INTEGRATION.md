# Polymarket — Integration Detail

Findings from an audit of the live Polymarket documentation (2026-07-12) against what the
ingestion leg needs (`apps/api`, `packages/integrations`). Verified via Polymarket's docs
MCP server — registered in `.mcp.json` (`polymarket-docs`, `https://docs.polymarket.com/mcp`),
so any Claude Code session in this repo can pull exact request/response schemas while building.
(Tip: the `api-reference/wss/*` pages there are schema stubs; the readable WebSocket guides
live under `/market-data/websocket/`.)

**Bottom line: every ingestion need is covered by public, unauthenticated endpoints.** Gamma
and the Data API are fully public; CLOB market data is public (only trading endpoints need
auth). No Polymarket account is required for the MVP.

## The three APIs (plus one we discovered)

| API | Base URL | Role for Edge Desk |
| --- | --- | --- |
| Gamma | `https://gamma-api.polymarket.com` | Market/event discovery, metadata, outcome→token mapping, sports metadata, tags, search |
| CLOB | `https://clob.polymarket.com` | Order book, BBO, midpoint, spread, tick size, price history |
| Data | `https://data-api.polymarket.com` | Trades (big-wallet flows), holders, positions, activity |
| Sports WS | `wss://sports-api.polymarket.com/ws` | **Live scores — the goal trigger** (not in the original plan) |

## Gamma — discovery and token mapping (`gamma.ts`)

- `GET /markets?slug=...`, `/markets/slug/{slug}`, `/markets/{id}`, plus `/events` equivalents.
- Filter listings with `active=true&closed=false`, `tag_id=...` (+`related_tags=true`),
  `order=volume_24hr`. Sports tags/metadata: `GET /sports`, valid market types, team lists.
- The market payload's **`clobTokenIds`** field maps outcomes to CLOB token IDs — this is what
  populates `market_outcomes.token_id`. Note: on single-market reads it arrives as a JSON
  *string* (`clobTokenIds: string | null`) — parse it.
- `GET /public-search` searches markets/events/profiles if slug is unknown.

## CLOB REST — snapshots and baseline recovery (`clob.ts`)

- `GET /book?token_id=...` — full order book; `GET /bbo` / spread / midpoint / market price /
  last trade price endpoints for lighter snapshots; tick size endpoints.
- `GET /prices-history?market=<tokenId>&startTs=...&interval=1m&fidelity=1` — historical prices
  at 1-minute fidelity. **Use this to (a) reconstruct a pre-event baseline if live capture
  missed it (avoids `needs_review`), and (b) build replay fixtures from resolved markets.**

## CLOB WebSocket — live watched prices (`clob.ts` `subscribeMarket`)

- Endpoint: `wss://ws-subscriptions-clob.polymarket.com/ws/market` (public).
- Subscribe: `{"assets_ids": ["<tokenId>", ...], "type": "market", "custom_feature_enabled": true}`.
- Message `event_type`s: `book` (on subscribe + on trades; full bids/asks), `price_change`
  (per-level updates incl. `best_bid`/`best_ask`; `size: "0"` = level removed),
  `last_trade_price`, `tick_size_change` (fires when price > 0.96 or < 0.04);
  with `custom_feature_enabled` also `best_bid_ask`, `new_market`, `market_resolved`
  (payload includes `clob_token_ids`).
- `market_resolved` can drive `markets.status = 'resolved'` automatically.

## Sports WebSocket — the event trigger (plan change)

The plan assumed an external "live event feed" would supply goal triggers. **Polymarket itself
broadcasts one**, which keeps the entire trigger→alert loop on sponsor APIs:

- Endpoint: `wss://sports-api.polymarket.com/ws` — no auth, **no subscription message**;
  it's a firehose of all active games, filter client-side by `slug`.
- Heartbeat: server sends `ping` every 5s; reply `pong` within 10s or be disconnected.
- One message type, `sport_result`: fires on match-live, score change, period change, match
  end. Fields: `gameId`, `leagueAbbreviation`, `slug` (`{league}-{team1}-{team2}-{date}`),
  `homeTeam`, `awayTeam`, `status`, `score`, `period`, `elapsed`, `live`, `ended`,
  `finished_timestamp` (ISO, only when ended).
- **Live-feed deviation (observed 2026-07-12): real messages carry NO `slug` field** despite
  the docs; `elapsed` is often absent too. The adapter
  (`packages/integrations/src/polymarket/sports.ts`) synthesizes a stable key
  `{leagueAbbreviation}-{gameId}` (e.g. `lol-1541773`) when `slug` is missing — register
  that synthesized form in `markets.game_slug`. Find a game's id by watching the feed or
  via Gamma sports metadata; esports report composite scores (`1-1|2-1|Bo5`) and
  `running/finished` statuses, which verbatim score-diffing handles unchanged.
- Soccer statuses: `Scheduled | InProgress | Break | Suspended | PenaltyShootout | Final |
  Awarded | Postponed | Canceled`; periods `1H/2H/HT/FT/FT OT/FT NR`.
- **A "goal" is not an explicit event** — the ingestion worker derives it by diffing `score`
  across messages for the watched slug, then posts a normalized event to `POST /v1/events`
  with a stable `sourceEventId` (e.g. `{slug}-{score}` → `"goal"` idempotency for free).
- Polymarket's own warning: the feed "may be delayed, contain errors, or omit recent events"
  — exactly why the evidence adapter's Linkup corroboration step stays (see
  [LINKUP_INTEGRATION.md](LINKUP_INTEGRATION.md)).
- Map feed→market via `markets.game_slug` (migration 002), set at registration
  (`POST /v1/markets`). Because the live feed omits `slug`, matching on a slug embedded in
  Gamma market slugs does not work — use the synthesized `{league}-{gameId}` key above.

## Data API — big-wallet flows are de-risked (`data.ts`)

docs/README.md originally flagged big-wallet flows as "no clean single endpoint… highest-risk
single task". **Current docs contradict that** — there are clean endpoints:

- `GET /trades?market=<conditionId,...>&filterType=CASH&filterAmount=<usd>&takerOnly=true`
  — large trades for a market, directly. Also `side`, `start`/`end` (epoch s), `limit`/`offset`.
  Response rows carry `proxyWallet`, `side`, `size`, `price`, `outcome`, `outcomeIndex`,
  `conditionId`, `timestamp`, `transactionHash`.
- `GET /holders?market=<conditionId>&minBalance=...` — top holders per outcome token (cap 20).
- No on-chain/subgraph spike needed. Optional signal, still cut-able under time pressure.

## Rate limits (Cloudflare-throttled: delayed, not rejected; sliding windows)

| API | General | Notable per-endpoint |
| --- | --- | --- |
| Gamma | 4,000 req/10s | `/events` 500/10s · `/markets` 300/10s · listings 900/10s · search 350/10s |
| Data | 1,000 req/10s | `/trades` 200/10s · `/positions` 150/10s |
| Global | 15,000 req/10s | health `/ok` 100/10s |

Our cadence (WS-driven prices + a few REST snapshots per event + hourly discovery) is orders
of magnitude below these. Polling odds every 30–120s per market: trivially fine.

## Adapter mapping

| Plan capability (§4.4) | Endpoint(s) |
| --- | --- |
| Resolve metadata + token IDs | Gamma `/markets`, `clobTokenIds` |
| Live price/spread/trades | CLOB WS market channel |
| REST snapshots (startup, recovery, +10/+20/+40) | CLOB `/book`, BBO/midpoint/spread |
| Pre-event baseline recovery | CLOB `/prices-history` (1-min fidelity) |
| Depth for configured notional | CLOB `/book` (sum levels) |
| Activity / big wallets (optional) | Data `/trades` + `/holders` |
| Event trigger (sports) | Sports WS `sport_result` → `POST /v1/events` |
