// Posts a "watched markets + current odds" card to the Telegram alerts group via the
// Bot API directly (operator/demo tool — real ALERTS go through the Hermes gateway
// webhook, this card is informational). Odds come from the latest market_snapshots
// rows, which the CLOB-WS recorder keeps ~1s fresh for watched markets.
//
// Run: npm run telegram:markets   (root)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.env') });

const { getPool } = await import('@edge-desk/db');

interface Row {
  title: string;
  game_slug: string | null;
  outcome: string;
  yes_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  spread_bps: number | null;
  observed_at: Date | null;
}

const { rows } = await getPool().query<Row>(
  `select m.title, m.game_slug, mo.name as outcome,
          s.yes_price, s.best_bid, s.best_ask, s.spread_bps, s.observed_at
     from markets m
     join market_outcomes mo on mo.market_id = m.id
     left join lateral (
       select * from market_snapshots ms
        where ms.outcome_id = mo.id and ms.provider is not null
        order by ms.observed_at desc limit 1
     ) s on true
    where m.status = 'active'
    order by m.created_at, mo.name`,
);

const cents = (v: string | null) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}c`);

const byMarket = new Map<string, { gameSlug: string | null; lines: string[]; fresh: Date | null }>();
for (const r of rows) {
  if (r.observed_at == null) continue; // skip markets with no real price data
  const entry = byMarket.get(r.title) ?? { gameSlug: r.game_slug, lines: [], fresh: null };
  entry.lines.push(
    `  ${r.outcome}: ${cents(r.yes_price)} (bid ${cents(r.best_bid)} / ask ${cents(r.best_ask)}, spread ${r.spread_bps ?? '—'}bps)`,
  );
  if (!entry.fresh || r.observed_at > entry.fresh) entry.fresh = r.observed_at;
  byMarket.set(r.title, entry);
}

let n = 0;
const sections = [...byMarket.entries()].map(([title, m]) => {
  n += 1;
  const feed = m.gameSlug ? `  live feed: ${m.gameSlug}` : '';
  return [`${n}. ${title}`, ...m.lines, feed].filter(Boolean).join('\n');
});

const card = [
  'EDGE DESK — WATCHED MARKETS',
  '',
  sections.length ? sections.join('\n\n') : '(no active markets with price data)',
  '',
  `As of ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  'Mode: notification only',
].join('\n');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID are required');

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: Number(chatId), text: card }),
});
const body = (await res.json()) as { ok: boolean; result?: { message_id: number } };
console.log(body.ok ? `posted market card (message ${body.result?.message_id})` : `FAILED: ${JSON.stringify(body)}`);
console.log('---\n' + card);
await getPool().end();
