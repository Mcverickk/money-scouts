# Hackathon Rules and Scoring

Track: **AI as Agency** (not Revenue). Root proof is a working, observable, self-evaluating agent org, not paying subscribers.

## Scoring targets

| Parameter | Weight | Target | What proves it for Edge Desk |
| --- | --- | --- | --- |
| Working product, real output | 20x (max 80) | L4, stretch L5 | Real Polymarket API + real Telegram send + durable PostgreSQL writes, no staging. Alerts are informational (no trade execution), so the pipeline can run end-to-end autonomously and escalate only low-confidence calls to a human. |
| Agent org structure | 5x (max 20) | L4, stretch L5 | Manager routes to a named domain specialist; the specialist dispatches price/evidence capability tasks and reviews outputs before the lag detector runs. L5 stretch: manager spawns a one-off deep-dive specialist on ambiguous signals, and agents escalate with a concrete blocker instead of failing silently. |
| Observability | 7x (max 28) | L4 | Second-highest weight on the whole rubric — invest here. Per-alert trace tree (specialist and capability results, lag score, delivery), tokens/cost per step, filterable by role or market. Stretch: diff a good alert vs. a bad one side by side. |
| Evaluation and iteration | 5x (max 20) | L4, stretch L5 | The outcome tracker *is* the eval loop: named set of historical resolved markets with known good/bad calls, run before/after changes; ideally closed-loop, where a wrong alert becomes a new eval case and reweights the lag detector automatically. |
| Agent handoffs and memory | 2x (max 8) | L4, stretch L5 | PostgreSQL holds market history, subscriber filters, and threshold policy; the manager passes accumulated signal context (not raw data) across the handoff chain. |
| Cost and latency per task | 1x (max 4) | L5 | One specialist check + lag-scoring cycle is cheap, read-only API calls — realistic sub-1-minute, sub-$0.10. Show this from the trace, not a claim. |
| Management UI | 1x (max 4) | L3, stretch L4 | Non-engineer can add/remove watched markets, edit filters, and pause monitoring from a UI, not code. |

### Power-ups, priority order

PostgreSQL (core ledger), Linkup (evidence discovery), and Cloudflare (scoreboard/hosting) are core. Dodo Payments is an optional entitlement gate—pursue it only after free-channel delivery is stable. ElevenLabs/Wispr Flow have no natural fit in a text-alert product; skip them unless voice ends up in the control surface.
