// Hermes orchestration wrapper (docs/TECH_ARCHITECTURE.md §4.3).
// Loads market config + baseline + alert history, routes the event to a domain
// specialist, fans out price/evidence via Hermes delegate_task, reviews outputs,
// persists every step to agent_runs/run_steps, then invokes the matcher.
// Owner: Hermes leg. See docs/HERMES_INTEGRATION.md for the primitive split.

export {};
