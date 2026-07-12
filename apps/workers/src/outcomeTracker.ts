// Outcome tracker (docs/TECH_ARCHITECTURE.md §4.9).
// Claims due outcome_jobs (+10/+20/+40 min from sent_at), fetches a fresh snapshot,
// labels correct/wrong/flat/invalid_data with a versioned policy, and preserves both
// scheduled_for and checked_at — a late check must not masquerade as on-time.
// Intended to run from a frequent Hermes cron with no_agent=true (docs/HERMES_INTEGRATION.md).

export {};
