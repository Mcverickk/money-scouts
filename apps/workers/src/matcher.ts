// Matcher worker (docs/TECH_ARCHITECTURE.md §4.7).
// Joins the specialist signal to a market outcome, calls @edge-desk/scoring's
// deterministic evaluateLag, and writes decision + alert + outbox in ONE transaction.
// Decisions are immutable; re-analysis creates a new decision.

export {};
