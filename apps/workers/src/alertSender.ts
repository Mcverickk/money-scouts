// Alert sender worker (docs/TECH_ARCHITECTURE.md §4.8).
// Claims pending delivery_outbox rows with row locking (FOR UPDATE SKIP LOCKED),
// composes the cited card, sends via the Hermes Telegram gateway, records the
// provider message ID, and retries transient failures with capped backoff.

export {};
