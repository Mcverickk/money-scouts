# Demo Script — Edge Desk end-to-end

Two demo modes. Both drive the REAL pipeline — real Polymarket order books, real Linkup
evidence, real Hermes analysis, real Telegram delivery. The only difference is where the
score-change trigger comes from.

## Mode A — live game (most impressive, needs a game in progress)

1. Find a live game with a Polymarket market (esports run all day):
   watch the feed for candidates, then find the market via Gamma
   `GET /public-search?q=<team>`.
2. Register it (game key format `{leagueAbbreviation}-{gameId}` — the live feed omits the
   documented slug):

   ```sh
   curl -X POST https://api-production-5c33.up.railway.app/v1/markets \
     -H 'content-type: application/json' \
     -d '{"slugOrId":"<market-slug>","category":"sports","gameSlug":"<league>-<gameId>"}'
   ```

3. Wait for the next score change. The Railway ingestor does the rest.

## Mode B — replay fixture (deterministic, demo-safe)

The mock feed replays a versioned fixture (`packages/replay/fixtures/`) over WebSocket in
the live feed's exact shape. The ingestor is pointed at it via the adapter's env override —
no code changes, no synthetic DB rows; the trigger enters through the public `/v1/events`
contract like any live goal.

```sh
# terminal 1 — mock feed (Norway vs England, goal at t+10s)
npm run demo:feed norway-england-goal

# terminal 2 — a local ingestor pointed at the mock feed
POLYMARKET_SPORTS_WS_URL=ws://127.0.0.1:9800 npm run dev:ingestor

# once: register the demo market mapped to the fixture's game slug (demo-999001).
# Use a real, liquid Polymarket market so baselines/spread/depth are real:
curl -X POST https://api-production-5c33.up.railway.app/v1/markets \
  -H 'content-type: application/json' \
  -d '{"slugOrId":"will-argentina-win-the-2026-fifa-world-cup-245","category":"sports","gameSlug":"demo-999001"}'
```

Timeline after the feed starts: t+0s seed score 0-0 → t+10s goal (0-1) → ingestor diffs the
score, corroborates via Linkup, POSTs event + evidence → API stores event + evidence +
queued run in one transaction → Hermes orchestrator claims, runs the sports specialist →
deterministic matcher gates → alert + outbox → Telegram card in "EdgeDesk Signals".

Rerunning the demo: the dedupe key is `{slug}-{score}`, so a second replay of the same
fixture is a duplicate by design (shows idempotency). To fire a fresh alert, bump the
fixture's scores (e.g. 0-1 → 0-2) or use a new fixture version.

Caveats:
- Replay events currently flow with `mode='live'` and `source='polymarket_sports_ws'`.
  The full `/v1/replays` labeled-replay path (TECH_ARCHITECTURE §4.11) is still open —
  don't mix demo stats into any published hit-rate.
- The matcher's gates run against the REAL market's current book; a fixture goal on a flat
  market shows maximal lag (good for the demo), but cooldown rules apply on reruns.

## What to show while it runs (observability rubric)

- The 202 response with `runId`, then the same run in PostgreSQL: `agent_runs` →
  `run_steps` (plan, signal, tokens, latency) → `decisions` (expected/observed/lag bps,
  gates) → `alerts` → `delivery_outbox` (idempotency key, attempts, provider message id).
- `evidence` rows with source tiers and retrieval timestamps behind the cited card.
- The Telegram card's trace id ↔ the run id in the database.
