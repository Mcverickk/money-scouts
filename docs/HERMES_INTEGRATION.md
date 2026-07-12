# Hermes Agent — Implementation Detail

How the Hermes Agent runtime is used inside Edge Desk: which primitives back which parts of the pipeline, and why.

Confirmed: this is [Nous Research's Hermes Agent](https://github.com/nousresearch/hermes-agent), an open-source agent runtime with a CLI, gateway daemon, and documented API surface. ([docs](https://hermes-agent.nousresearch.com/docs/))

It ships with two *different* delegation primitives, and picking the right one for each part of Edge Desk matters for the score, not just for getting it working:

## API Server bridge — the TypeScript orchestrator service

`apps/workers` embeds no imitation of Hermes. It connects to the real Hermes gateway through
the authenticated [API Server Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/):

```text
agent_runs.status = queued
-> orchestrator worker claims the row with FOR UPDATE SKIP LOCKED
-> loads the normalized event, evidence, outcomes, snapshots, and recent alerts
-> POST /v1/runs to Hermes with per-run session id and per-market memory key
-> Hermes manager plans, calls delegate_task, and reviews specialist output
-> worker polls /v1/runs/{id}, validates the JSON signal against supplied IDs
-> run_steps stores plan, signal, review, model, tokens, latency, and source refs
-> deterministic matcher consumes that stored signal
```

Hermes setup on the gateway host:

```sh
# ~/.hermes/.env
API_SERVER_ENABLED=true
API_SERVER_KEY=replace-with-a-long-random-key

hermes tools   # enable the delegation toolset for the api_server platform
hermes gateway
```

Application configuration uses the same bearer key:

```sh
HERMES_API_URL=http://127.0.0.1:8642
HERMES_API_KEY=replace-with-a-long-random-key
HERMES_API_MODEL=hermes-agent
```

The bridge uses `X-Hermes-Session-Key=edge-desk:market:<market-id>` so relevant Hermes
memory is scoped to a market, while every application run gets its own transcript session.
PostgreSQL row claiming and the durable `hermes_task_id` are the application's idempotency
boundary. The client also sends an `Idempotency-Key` derived from `agent_runs.id` for API
versions that support run-submission deduplication; Hermes v0.18.2 does not yet deduplicate
`POST /v1/runs`, so a crash after submission can leave an orphan Hermes run for reconciliation.

Provider content is explicitly marked untrusted in the manager prompt. The returned category,
outcome token, evidence IDs, numeric ranges, plan, signal, and review are checked in code before
they enter the matcher. A manager rejection becomes a hard `manager_review_failed` risk flag.
Hermes runs that require approval are not auto-approved by this service.

The API Server has access to the configured Hermes toolset, potentially including terminal and
file operations. Keep it bound to loopback or a private network, protect it with `API_SERVER_KEY`,
and enable only the toolsets required by the Edge Desk profile.

## Telegram direct delivery — final decision notifications

Telegram delivery happens only after the deterministic matcher creates an `alerts` row and a
matching `delivery_outbox` row. The alert sender does not ask another model to reconsider the
decision. It calls Hermes' signed webhook adapter with `deliver_only: true`; Hermes then sends
the stored message through its configured Telegram gateway.

This gives the application synchronous delivery acknowledgement, HMAC authentication, rate
limits, and one-hour deduplication through `X-Request-ID`, while keeping the Telegram bot token
inside Hermes rather than the Node.js service.

Configure the Hermes host:

```sh
# ~/.hermes/.env
TELEGRAM_BOT_TOKEN=123456:replace-me
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=replace-with-a-long-random-secret
```

Add the direct-delivery route to `~/.hermes/config.yaml`:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      secret: replace-with-a-long-random-secret
      routes:
        edge-desk-alert:
          secret: replace-with-a-long-random-secret
          deliver: telegram
          deliver_only: true
          prompt: "{message}"
          deliver_extra:
            chat_id: "{destination}"
```

The application uses the matching route secret:

```sh
HERMES_TELEGRAM_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/edge-desk-alert
HERMES_TELEGRAM_WEBHOOK_SECRET=replace-with-a-long-random-secret
TELEGRAM_ALERT_CHAT_ID=-1001234567890
WORKER_ROLES=orchestrator,matcher,alert_sender
```

The `matcher` role consumes completed Hermes orchestration steps, runs the deterministic lag
policy, and atomically writes the decision plus alert/outbox rows only for `notify`. The
`alert_sender` role then delivers those rows. This separation means Hermes supplies the
reviewed market signal, while application code retains the final notification gates.

`delivery_outbox.destination` must be the Telegram chat ID (negative IDs are normal for groups).
The client signs `<unix_timestamp>.<exact_json_body>` with HMAC-SHA256 and sends the V2 signature
headers expected by Hermes. `delivery_outbox.idempotency_key` becomes `X-Request-ID`; a retry
that Hermes already delivered returns `status=duplicate` and is treated as success.

On success, the sender atomically:

- Marks the outbox row and alert `sent` and stores Hermes' delivery ID.
- Creates the `+2/+3/+5` minute outcome jobs relative to the actual send time
  (`OUTCOME_HORIZONS_MINUTES`, shortened from the spec's +10/+20/+40 for fast demo feedback).

Transient network, rate-limit, and gateway failures use capped exponential backoff. Invalid
authentication/configuration fails permanently rather than retrying forever. Run a one-off
Telegram smoke test before starting workers:

```sh
hermes send --to telegram:<chat-id> "Edge Desk Telegram smoke test"
```

## `delegate_task` — for real-time capability fan-out

```python
delegate_task(tasks=[
    {"goal": "Check order book for market X, report current odds + depth", "toolsets": ["web"]},
    {"goal": "Search for breaking news on market X's topic in the last 30 min", "toolsets": ["web"]},
    {"goal": "Check large wallet activity on market X", "toolsets": ["web"]},
])
```

- Synchronous, parallel, fast (`ThreadPoolExecutor`, default 3 concurrent children). Each subagent gets a **fresh conversation** — zero shared history, so the manager must pass full context via `goal`/`context`.
- Only the final summary returns to the parent — cheap on tokens, but **the intermediate results are not durably stored** unless we explicitly write them to PostgreSQL.
- This is the right tool for a specialist's price/evidence/activity fan-out: the checks need to run *now*, in parallel, and report back into a single lag-detection pass. It matches the cost/latency target (sub-1-minute per cycle) since it is a direct RPC, not a polling loop.

## Kanban — for the alert's lifecycle, review, and escalation

This is the better fit for the manager/org-structure and observability requirements, and it isn't the obvious first choice — it's built almost exactly for what the rubric's L4/L5 org-structure examples describe:

- A durable SQLite task board (`~/.hermes/kanban.db`), not a fire-and-forget call. Every task is a row with a status lifecycle (`triage → todo → ready → running → blocked → done → archived`), an assignee (a **named** specialist profile, not an anonymous subagent), and a full event history (`task_events` table) that survives forever — this *is* the observability trace the rubric asks for ("pick a run and see what each agent did, step by step").
- `kanban_block(reason)` / `kanban_comment()` / `kanban_unblock()` is a built-in review-and-send-back-for-revision loop — literally the L4 org-structure criterion ("manager... reviews outputs, sends back for revision").
- Dependency links (`kanban_create(..., parents=[...])`) mean the lag-detector task can start only once all required capability tasks complete — no custom join logic needed.
- `hermes kanban watch` / `hermes dashboard` gives a live board view for free — this can BE (or back) the management UI and the observability dashboard, rather than building either from scratch.
- **L5 org-structure stretch is a config flag, not new code**: default `max_spawn_depth` is 1 (flat). Setting a profile's `role="orchestrator"` and raising `max_spawn_depth` lets the manager spawn new specialist roles mid-task — the exact "emergent org" criterion.
- Auto-decomposition (`kanban.auto_decompose: true`, default) can run an LLM decomposer on a "watch market X" triage task and fan it into the graph automatically — this can *be* the manager's planning step instead of us hand-writing it.

**Recommended split:** each domain specialist uses `delegate_task` for fast capability fan-out; the alert's post-publish lifecycle (outcome tracking, review, escalation-by-exception, eval feedback) runs as durable tasks, because that part of the pipeline must survive the multi-minute convergence window, be inspectable afterward, and support human review on exceptions.

## Cron — the outcome tracker

```python
cronjob(action="create", name="edge-desk-outcomes",
        schedule="every 1m", script="edge-desk-outcomes.py",
        no_agent=True, deliver="telegram")
```

- PostgreSQL `outcome_jobs` remains the authoritative list of `+2/+3/+5` minute work. A frequent Hermes cron script can atomically claim due rows, fetch prices, and write outcomes.
- The gateway daemon ticks the scheduler every 60 seconds. In `no_agent=True` mode the script runs without an LLM; empty stdout stays silent, while failures can still deliver to Telegram.
- Use an agent only for a disputed outcome that requires interpretation. Routine price math stays deterministic and near-zero token cost.

## Messaging gateway — Telegram

1. Create the bot via **@BotFather** (`/newbot`) → get `TELEGRAM_BOT_TOKEN`.
2. `hermes gateway setup` (interactive) or set `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_USERS` in `~/.hermes/.env`.
3. `hermes gateway` to test in foreground; `hermes gateway install --system` for a persistent systemd/launchd service during the demo.
4. **Subscriber onboarding maps directly onto Hermes' DM pairing flow**: an unknown user messages the bot, gets a one-time pairing code, we approve via `hermes pairing approve telegram [CODE]` — this can double as the "subscriber" concept without building custom auth.
5. `/sethome` or `TELEGRAM_HOME_CHANNEL` sets where cron output and proactive alerts land — this is the public/shared alert channel.
6. The gateway supports additional messaging platforms through the same daemon. Treat multi-channel delivery as a later extension and verify the desired adapter before committing scope.

## Memory split

Hermes' own memory (`MEMORY.md`/`USER.md`, agent-curated, FTS5 session search) is the agent's *working notes* layer. It is **not** a replacement for PostgreSQL: PostgreSQL stays the product's structured, mentor-inspectable ledger (alert history, subscriber filters, outcome scores). Cooldown enforcement belongs in deterministic database-backed policy, not only in agent memory.

## How this gets "detected" / verified by mentors

Because Kanban's `task_events` table, run history, and dashboard are durable and queryable by construction, the standard rubric verification pattern ("mentor names a past run, team opens it live") is satisfied by `hermes kanban show <id>` / `hermes kanban runs <id>` / `hermes dashboard` directly — no extra tooling required to prove Hermes is the real runtime, not window dressing.

## Open implementation risks

- **Dispatch latency vs. the cost/latency L5 target**: Kanban's dispatcher polls every 60s by default (`dispatch_interval_seconds`) — that alone risks blowing a sub-1-minute budget before any work happens. Tune this down for the demo, or keep the tightest-latency step (capability fan-out → lag score) on `delegate_task` and reserve Kanban for the slower post-alert lifecycle where 60s polling does not matter.
- **Token/cost-per-step isn't natively surfaced by Kanban** — capture usage at step completion and write it into PostgreSQL to hit the Observability L4 "tokens and cost per step" bar.
- **Requires an LLM provider** — Nous Portal, OpenRouter, or OpenAI key via `hermes model` / `hermes setup --portal`. Whoever sets up the gateway needs one before anything runs live.
