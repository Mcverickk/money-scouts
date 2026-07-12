# Hermes Buildathon — Edge Desk

Edge Desk is an **agency**: a small team of domain-specialist AI agents that watches Polymarket order books and fresh real-world evidence, flags markets whose odds lag reality, and ships a cited Telegram alert instead of a trade.

**The plan is the source of truth.** Product design, architecture, data model, and API contracts live in [`docs/`](docs) — code follows the plan; if code must deviate, update the doc in the same commit.

## Repo structure

- [`docs/`](docs) — the Edge Desk plan: loop, [technical architecture](docs/TECH_ARCHITECTURE.md), [responsibility boundaries](docs/HERMES_MARKET_AGENT_CONTEXT.md), [Hermes runtime usage](docs/HERMES_INTEGRATION.md).
- [`hackathon-context/`](hackathon-context) — track, scoring rubric, team and sprint constraints.
- `apps/api` — ingest API: `POST /v1/events`, `/v1/market-checks`, `/v1/replays` (TECH_ARCHITECTURE §4.2).
- `apps/workers` — orchestrator, matcher, alert sender, outcome tracker (§4.3, §4.7–4.9).
- `apps/web` — management UI + public scoreboard (unowned; `hermes dashboard` may cover part of it).
- `apps/landing` — public landing page (static, Cloudflare Pages).
- `packages/contracts` — shared TypeScript contracts between the legs. **Announce before changing.**
- `packages/db` — PostgreSQL migrations (§5) + pool. **Announce before changing.**
- `packages/integrations` — Polymarket (Gamma/CLOB/Data), Linkup, Telegram adapters (§4.4–4.5).
- `packages/agents` — domain specialists; sports only for MVP (§4.6).
- `packages/scoring` — deterministic lag detector (§4.7) — implemented, policy `sports-v1`.
- `packages/replay` — versioned demo/regression fixtures (§4.11).

## Ownership

| Area | Owner |
| --- | --- |
| Ingestion: `apps/api`, `packages/integrations`, `packages/db` | Chirag |
| Hermes leg: `packages/agents`, `apps/workers`, Telegram gateway | Hermes owner |
| Landing page: `apps/landing` | Business |
| Shared seams: `packages/contracts`, migrations, `docs/` | everyone — announce changes |
| `apps/web` (dashboard + scoreboard) | **unassigned** — needs an owner |

## Quickstart

```sh
npm install
cp .env.example .env       # fill in DATABASE_URL, keys
npm run db:migrate         # apply packages/db/migrations
npm run dev:api            # ingest API on :3000 (GET /health)
npm run dev:workers        # Hermes orchestrator worker (requires Hermes API Server)
npm test                   # orchestrator trust-boundary and Hermes API client tests
npm run typecheck
```

Before starting workers, enable Hermes' API Server in `~/.hermes/.env` with
`API_SERVER_ENABLED=true` and the same bearer key as `HERMES_API_KEY`, then run
`hermes gateway`. See [`docs/HERMES_INTEGRATION.md`](docs/HERMES_INTEGRATION.md#api-server-bridge--the-typescript-orchestrator-service).

## Working agreement (8-hour sprint)

- Commit small and directly to `main`; `git pull --rebase` before every push.
- Stay inside your owned directories; coordinate in chat before touching a shared seam.
- Build order: docs/TECH_ARCHITECTURE.md §9 — stop after step 11 before widening categories.
