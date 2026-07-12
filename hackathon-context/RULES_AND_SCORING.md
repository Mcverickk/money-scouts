# Hackathon Rules and Scoring

Track: **03 · AI as Agency** (not Revenue). 164 base points + uncapped overflow.

## Framework

A team of AI agents replaces a full human function. A manager agent plans, specialists execute, handoffs pass work between them, memory persists across tasks, and a control surface lets a non-engineer assign work.

**The framework question:** if an agency was run with agents instead of humans, how would it work?

Every parameter below is scored L1 (lowest) through L5 (highest), verified live by a mentor — not by claims.

---

## 1. Working product shipping real output — 20x, max 80

Root parameter. Real surface = a system a paying customer could use tomorrow. Staged WordPress or sandbox Gmail caps at L3. **Overflow past L5: +1 pt × 20x per additional real task completed autonomously during judging** (uncapped).

- **L1 — Demo only, canned responses. 0 completed tasks.** The agents talk through the workflow but do not complete the declared job. No usable output lands anywhere; no data flows in or out of any system.
  *Example: the crew says it screened a candidate, but no scorecard, ATS update, rejection, shortlist, or next-step decision is created.*
- **L2 — Agents run but output is broken or hallucinated. Under 30% task success.** The crew executes, but the output is broken, fake, incomplete, or unusable. Mentors verify by re-running the task and checking whether anything true and usable was produced.
  *Example: in payments, it pulls the wrong transaction or reports a refund as reversed without checking the payment record.*
- **L3 — Working output on staged or test surfaces. 50–70% task success.** The crew completes a useful part of the declared job and creates at least one usable artifact. Staged WordPress, sandbox Gmail, dummy ATS, mocked CRM, Airtable, Notion, or Google Sheets all live here — this is the ceiling for staged surfaces.
  *Example: the crew verifies an order against a mocked order DB, writes to a mocked dispatch system, or classifies a payment dispute and files it in a test tracker.*
- **L4 — Real output on real surfaces, human approves every step. 70–85% task success.** The crew completes most of the declared job across a realistic workflow: it retrieves, classifies, decides, and writes on the happy path, but a human reviews before anything final moves, and edge cases break it.
  *Example: the crew drafts the refund ticket inside the real support queue, but a support lead must approve the refund.*
- **L5 — End to end on real live surfaces, 85%+ success across 3+ repeated runs, escalates by exception only.** The crew completes the declared job without judge intervention: retrieves, classifies, decides, writes, and escalates by exception only, handing edge cases to a human with full context instead of a restart. Output lands on real live surfaces at production quality.
  *Example: in quick commerce, the crew verifies the order, finds missing items, checks refund eligibility, writes back to the queue, updates the ticket, and escalates only exceptions.*

## 2. Agent org structure — 5x, max 20

How the agent team is organized. Flat vs. managed, static vs. dynamic delegation.

- **L1 — One monolithic agent does everything.** A single agent with one giant prompt handles the entire function; there is no division of labor. Verified by opening the trace of any run: one agent, one context.
- **L2 — 2–3 agents with hardcoded handoffs, no manager.** Work is split, but the pipeline is fixed: agent A always hands to agent B in the same order, with no one deciding what the task actually needs.
- **L3 — Clear roles (manager + specialists), static routing.** There is a real org: a manager and named specialists with distinct jobs, but routing follows a fixed table rather than a plan.
  *Example: a support manager agent routes billing tickets to the billing specialist via a fixed routing table.*
- **L4 — Dynamic: manager agent plans subtasks based on the specific request, delegates, reviews outputs.** The manager reads the specific request, decomposes it into subtasks, assigns them, and reviews outputs before accepting them. Verified with two structurally different requests producing different plans, plus at least one output sent back for revision.
- **L5 — Emergent org: manager spawns sub-specialists on the fly, agents escalate when stuck, roles self-adjust to task.** The org itself is dynamic: the manager spawns new specialists when a task demands one, stuck agents escalate with a concrete blocker instead of failing quietly. Verified by finding a run where the trace shows a role that did not exist at kickoff.

## 3. Observability — 7x, max 28

Second-highest weight on the whole rubric. **Tool-agnostic**: Langfuse, Braintrust, OTel, or a homebrewed dashboard over Postgres all score the same at every tier — the question is what a mentor can see, not which logo is used.

- **L1 — `console.log`/`print` statements only.** Nothing is stored in a queryable form. Asked what happened in a run from an hour ago, the answer is scrollback or nothing.
- **L2 — Structured logs written to a file, no UI.** Events are captured in a structured, persistent form (JSONL, DB rows) so runs can be reconstructed, but only by grepping or writing queries.
- **L3 — Can pull up a specific run and see what each agent did, step by step** (any tool: custom, self-hosted OSS, SaaS, OTel). A mentor can name a past run and watch the team open it and walk it live.
- **L4 — Trace tree across agents (who called whom), token and cost per step, filter by agent or task.** The view shows who called whom as a tree, with tokens and cost attributed to every step, sliceable by agent or task.
- **L5 — Production-grade: diff two runs side by side, alerts on failure or cost spike, search across runs.** Tooling a senior engineer would trust to debug prod.

## 4. Evaluation and iteration — 5x, max 20

Ability to improve the system over time. Manual vs. closed-loop.

- **L1 — No evals.** There is no defined way to tell whether the system got better or worse; changes ship on vibes.
- **L2 — Manual spot-checks ("this run looked fine").** Quality is checked by eyeballing a handful of favorite runs after each change, no fixed set, no scores recorded.
- **L3 — Named eval set exists, run manually to compare versions.** A fixed, named set of test cases with expected outcomes, run by hand before/after changes.
  *Example: a hiring crew keeps 25 held-out resumes with agreed screen/reject decisions.*
- **L4 — Automated eval pipeline, CI-style, fails a release if quality drops.** Evals run automatically on every change, and a quality drop actually blocks the release.
- **L5 — Closed-loop: failed runs feed a growing eval set, version-controlled prompts and agents, measurable gains across versions.** Production failures automatically become new eval cases; quality is demonstrably climbing across versions with prompts tagged in git.

## 5. Agent handoffs and memory — 2x, max 8

Does context survive between agents and across tasks?

- **L1 — Remembers nothing, every turn starts from zero.** The user re-introduces themselves and re-states the issue every turn.
- **L2 — Holds one or two basic fields within the task.** The agent remembers who it is dealing with or one identifier, but not the actual task context.
- **L3 — Holds context within a single task, lost at handoff.** The agent remembers earlier turns inside the same run, but the next agent in a handoff re-asks for everything.
- **L4 — Holds context across the task and one or two handoffs.** The agent remembers the user's recent history and uses it for follow-up decisions; relevant context passes forward to the next agent.
- **L5 — Full relevant history and policy knowledge (now + this user's past + business rules), survives all handoffs.** Three layers in practice: what is happening now, what has happened before with this user, and what the business allows (rules/thresholds/policy).
  *This is the target shape for [Edge Desk's memory model](../Edge_desk/HERMES_INTEGRATION.md#memory-split).*

## 6. Cost and latency per task — 1x, max 4

The lower tier (slower or more expensive) governs.

- **L1 — Over 30 min OR over $5.**
- **L2 — 10–30 min OR $2–$5.**
- **L3 — 5–10 min OR $0.50–$2.**
- **L4 — 1–5 min OR $0.10–$0.50.**
- **L5 — Under 1 min AND under $0.10.** Both bounds must hold at once on a real task, verified live with a stopwatch and the trace's cost readout.

## 7. Management UI — 1x, max 4

L5 is tested live: a non-engineering volunteer onboards a new agent role unassisted.

- **L1 — CLI or code only.** Any behavior change requires editing code/config and redeploying.
- **L2 — Basic web UI, dev-only.** A thin, mostly read-only web layer; real operation still falls back to code.
- **L3 — Functional UI, a PM could operate with docs.** Core operations (pause, edit prompts, review outputs) are doable from the UI by a non-developer with documentation beside them.
- **L4 — Clean UI, non-eng operates with one walkthrough.** Self-explanatory enough that one guided walkthrough is all an operator needs for day-to-day operation.
- **L5 — Delightful UI, non-eng volunteer onboards a new agent role (job, tools, guardrails) in under 10 min unassisted.** Tested live during judging with a volunteer the team did not choose.

---

## AI as Agency total

80 + 20 + 28 + 20 + 8 + 4 + 4 = **164 base points**, plus uncapped real-output overflow on top.

## Power-ups on this track

Do the integration, earn the points: **+25 per partner, no cap** — all six = +150. Real use only; a mentor has to see it working live in the build.

| Power-up | Points | Counts when | Evidence |
| --- | --- | --- | --- |
| Wispr Flow | 25 | 500+ words dictated during the event | Wispr stats screenshot |
| ElevenLabs | 25 | Voice does real work in the product, not a dead snippet | Live demo of the interaction |
| Convex | 25 | Convex stores real product state or is the main backend | Repo + Convex dashboard |
| Linkup | 25 | Live search doing real work in the product | Code + live query |
| Dodo Payments | 25 | Live checkout in the product (an activated account alone earns nothing) | Dodo dashboard + live checkout |
| Cloudflare | 25 | Hosting, Workers, or any CF product doing real work | Live URL + CF dashboard |

### Edge Desk power-up priority

PostgreSQL (core ledger — not a listed power-up but required infra), Linkup (evidence discovery), and Cloudflare (scoreboard/hosting) are core. Dodo Payments is an optional entitlement gate — pursue it only after free-channel delivery is stable. ElevenLabs/Wispr Flow have no natural fit in a text-alert product; skip them unless voice ends up in the control surface.

## The edges — cross-track bonus

You pick one track, but wins outside it still pay. Wins from other tracks count at **half their home-track weight, capped at 50 total** per parameter, same proof required. Nothing is paid twice: if your own track (AI as Agency) already scores a parameter, there is no bonus on it.

| Source track | Parameter | Original weight | Bonus weight | Max bonus |
| --- | --- | --- | --- | --- |
| Virality | Signups | 25x | 12.5x | 50 |
| Virality | Visitors | 10x | 5x | 20 |
| Virality | Reactions + comments | 2x | 1x | 4 |
| Revenue | Signups | 20x | 10x | 40 |
| Revenue | Live product quality | 8x | 4x | 16 |
| Revenue | Revenue generated | 12x | 6x | 24 |
| AI as Agency | Real output shipping | 20x | 10x | 40 |
| AI as Agency | Observability | 7x | 3.5x | 14 |

---

## Edge Desk scoring targets

How Edge Desk maps onto the rubric above — target level and what proves it.

| Parameter | Weight | Target | What proves it for Edge Desk |
| --- | --- | --- | --- |
| Working product, real output | 20x (max 80) | L4, stretch L5 | Real Polymarket API + real Telegram send + durable PostgreSQL writes, no staging. Alerts are informational (no trade execution), so the pipeline can run end-to-end autonomously and escalate only low-confidence calls to a human. |
| Agent org structure | 5x (max 20) | L4, stretch L5 | Manager routes to a named domain specialist; the specialist dispatches price/evidence capability tasks and reviews outputs before the lag detector runs. L5 stretch: manager spawns a one-off deep-dive specialist on ambiguous signals, and agents escalate with a concrete blocker instead of failing silently. |
| Observability | 7x (max 28) | L4 | Second-highest weight on the whole rubric — invest here. Per-alert trace tree (specialist and capability results, lag score, delivery), tokens/cost per step, filterable by role or market. Stretch: diff a good alert vs. a bad one side by side. |
| Evaluation and iteration | 5x (max 20) | L4, stretch L5 | The outcome tracker *is* the eval loop: named set of historical resolved markets with known good/bad calls, run before/after changes; ideally closed-loop, where a wrong alert becomes a new eval case and reweights the lag detector automatically. |
| Agent handoffs and memory | 2x (max 8) | L4, stretch L5 | PostgreSQL holds market history, subscriber filters, and threshold policy; the manager passes accumulated signal context (not raw data) across the handoff chain. |
| Cost and latency per task | 1x (max 4) | L5 | One specialist check + lag-scoring cycle is cheap, read-only API calls — realistic sub-1-minute, sub-$0.10. Show this from the trace, not a claim. |
| Management UI | 1x (max 4) | L3, stretch L4 | Non-engineer can add/remove watched markets, edit filters, and pause monitoring from a UI, not code. |
