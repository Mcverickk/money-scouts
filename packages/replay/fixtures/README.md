# Replay fixtures

Immutable, versioned event timelines for demo + regression (docs/TECH_ARCHITECTURE.md §4.11).

Layout: one directory per fixture, one subdirectory per version, e.g.
`norway-england-goal/v1/` containing the ordered normalized events (the same JSON contract
as `POST /v1/events`) and the adapter-served snapshot series.

Rules: fixtures enter through `POST /v1/replays` → normal ingest path — never direct table
writes. Every generated row carries `mode='replay'` and `replay_run_id`. Replays never send
to production Telegram unless an allowlisted demo channel is configured.
