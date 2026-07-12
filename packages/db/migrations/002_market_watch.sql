-- Maps the Polymarket Sports WebSocket live-score feed onto registered markets.
-- Each sports market carries the feed's match slug ({league}-{team1}-{team2}-{date})
-- so an incoming goal/score event can be resolved to a market in one indexed lookup.
-- Nullable: geopolitics/crypto markets have no game feed, hence the partial index.

alter table markets add column game_slug text;

create index markets_game_slug
  on markets (game_slug) where game_slug is not null;
