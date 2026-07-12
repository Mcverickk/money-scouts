# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Edge Desk — an 8-hour hackathon build (Hermes Buildathon, "AI as Agency" track). Notification-only Polymarket market intelligence: domain-specialist agents watch order books and fresh evidence, a deterministic lag detector flags odds that lag reality, a cited alert goes to Telegram, and the call is scored at +10/+20/+40 minutes. No auto-trading.

## The plan is the source of truth

Code follows the docs, not vice versa. If code must deviate, update the doc in the same commit. Read before building:

- `docs/TECH_ARCHITECTURE.md` — components (§4), PostgreSQL schema (§5), API contracts (§6), build order (§9), demo success criteria (§14)
- `docs/HERMES_INTEGRATION.md` — which Hermes runtime primitive backs what: `delegate_task` for latency-sensitive fan-out, Kanban for post-alert lifecycle, cron (`no_agent=true`) for outcome checks
- `docs/HERMES_MARKET_AGENT_CONTEXT.md` — responsibility boundaries and the trigger/signal/decision contracts
- `hackathon-context/RULES_AND_SCORING.md` — observability is the second-highest-weighted rubric line; build traces alongside features, not after

## Commands

```sh
npm install
cp .env.example .env       # DATABASE_URL required for db/migrate and api
docker compose up -d postgres  # disposable Postgres matching .env.example
npm run db:migrate         # applies packages/db/migrations/*.sql in order, once each
npm run dev:api            # Fastify ingest API on :3000, tsx watch
npm run dev:workers        # requires Hermes API Server + HERMES_API_KEY
npm test                   # Hermes client/orchestrator tests; export DATABASE_URL (see below) to
                            # also run orchestratorService.integration.test.ts against real Postgres
npm run typecheck          # tsc --noEmit across all workspaces
```

No build step: everything runs through `tsx` directly from TypeScript source. Tests use
Node's built-in test runner through `tsx --test`. `apps/workers/src/*.test.ts` are pure/mocked
(no I/O); `orchestratorService.integration.test.ts` runs the same claim/load/persist code against
a real Postgres and self-skips when `DATABASE_URL` is absent. `npm run test -w @edge-desk/workers`
runs with cwd `apps/workers`, so the root `.env` is not auto-loaded there — export
`DATABASE_URL=postgres://postgres:postgres@localhost:5432/edge_desk` in the shell before `npm test`
to pick up the integration suite.

## Architecture

npm-workspaces monorepo; packages import each other as `@edge-desk/*` (root `tsconfig.json` paths + workspace symlinks — both must list a package for it to resolve).

Data flow: `apps/api` accepts normalized events (idempotent on `(source, sourceEventId)`, returns 202 + durable runId) → Hermes orchestrator (`apps/workers/src/orchestrator.ts`) routes to a domain specialist (`packages/agents`) which fans out through shared adapters (`packages/integrations`) → deterministic matcher (`packages/scoring/src/lagDetector.ts`) writes decision + alert + outbox **in one transaction** → alert sender delivers via the Hermes Telegram gateway → outcome tracker re-checks at +10/+20/+40. PostgreSQL (`packages/db`) is the system of record for everything, including the per-step agent trace.

The TypeScript orchestrator connects to the real Hermes runtime through its authenticated
API Server Runs API. `apps/workers/src/orchestratorService.ts` claims `agent_runs` with
`status='queued'`, submits normalized context to Hermes, validates its structured signal,
and stores the result in `run_steps`; the matcher remains a separate deterministic step.

Non-negotiable invariants from the plan:

- Lag needs a pre-event baseline; current price alone → `needs_review`, never `notify`.
- Lag math is direction-signed (`lagBps = expectedMoveBps − observedMoveBps × direction`).
- Replay fixtures enter through `POST /v1/replays` → normal ingest path, rows carry `mode='replay'`; never write synthetic rows into live tables, never mix replay and live metrics.
- Deterministic code owns price math and notify gates; LLMs only extract/classify/explain.
- Decisions are immutable; delivery is idempotent via `delivery_outbox.idempotency_key`.

## Team conventions

Three people, shared repo, commits go directly to `main` — `git pull --rebase` before push. Ownership map is in README.md; `packages/contracts` and `packages/db/migrations` are the seams between owners — announce changes before committing them.
