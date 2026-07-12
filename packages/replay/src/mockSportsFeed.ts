// Mock Polymarket sports feed — replays a versioned fixture timeline over WebSocket so a
// demo can trigger the REAL pipeline (ingestor -> API -> Hermes -> matcher -> Telegram)
// without waiting for a live goal. Point the ingestor at it with:
//   POLYMARKET_SPORTS_WS_URL=ws://127.0.0.1:9800 npm run dev:ingestor
// Mimics the live feed's shape (sport_result messages, no `slug` field, text-frame pings).
// Fixtures are immutable and versioned (docs/TECH_ARCHITECTURE.md §4.11).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

interface Fixture {
  name: string;
  version: string;
  description: string;
  game: {
    gameId: number;
    leagueAbbreviation: string;
    homeTeam: string;
    awayTeam: string;
    status: string;
    period: string;
    live: boolean;
    ended: boolean;
  };
  timeline: Array<{ afterSeconds: number; score: string; elapsed: string }>;
}

const fixtureName = process.argv[2] ?? 'norway-england-goal';
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixture = JSON.parse(
  readFileSync(path.join(fixturesDir, `${fixtureName}.json`), 'utf8'),
) as Fixture;

const port = Number(process.env.MOCK_FEED_PORT ?? 9800);
const gameSlug = `${fixture.game.leagueAbbreviation}-${fixture.game.gameId}`;

const wss = new WebSocketServer({ port });
console.log(`[mockFeed] fixture '${fixture.name}' v${fixture.version} on ws://127.0.0.1:${port}`);
console.log(`[mockFeed] derived game slug: ${gameSlug} — register the demo market with this game_slug`);

function sportResult(entry: Fixture['timeline'][number]) {
  return JSON.stringify({
    gameId: fixture.game.gameId,
    leagueAbbreviation: fixture.game.leagueAbbreviation,
    homeTeam: fixture.game.homeTeam,
    awayTeam: fixture.game.awayTeam,
    status: fixture.game.status,
    period: fixture.game.period,
    live: fixture.game.live,
    ended: fixture.game.ended,
    score: entry.score,
    elapsed: entry.elapsed,
  });
}

wss.on('connection', (ws: WebSocket) => {
  console.log('[mockFeed] client connected — replaying timeline');
  const timers: NodeJS.Timeout[] = [];

  for (const entry of fixture.timeline) {
    timers.push(
      setTimeout(() => {
        ws.send(sportResult(entry));
        console.log(`[mockFeed] emitted score ${entry.score} (${entry.elapsed})`);
      }, entry.afterSeconds * 1_000),
    );
  }

  // The real feed pings every 5s and drops clients that do not pong within 10s.
  const ping = setInterval(() => ws.send('ping'), 5_000);

  ws.on('close', () => {
    clearInterval(ping);
    for (const t of timers) clearTimeout(t);
    console.log('[mockFeed] client disconnected');
  });
});
