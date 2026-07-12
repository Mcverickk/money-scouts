-- Edge Desk system of record. Implements docs/TECH_ARCHITECTURE.md §5 verbatim:
-- UUID keys, timestamptz, jsonb raw payloads, explicit FKs, and the partial
-- unique indexes that keep live dedup safe from NULL replay_run_id semantics.

create extension if not exists pgcrypto;

create table replay_runs (
  id uuid primary key default gen_random_uuid(),
  fixture_name text not null,
  fixture_version text not null,
  status text not null default 'running',
  clock_config jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table markets (
  id uuid primary key default gen_random_uuid(),
  polymarket_market_id text not null unique,
  slug text,
  title text not null,
  category text not null check (category in ('sports', 'geopolitics', 'crypto')),
  status text not null default 'active' check (status in ('active', 'paused', 'resolved')),
  thresholds jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table market_outcomes (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets (id),
  name text not null,
  token_id text not null,
  side text,
  unique (market_id, token_id)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets (id),
  source text not null,
  source_event_id text not null,
  event_type text,
  event_text text,
  source_url text,
  payload jsonb,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  mode text not null default 'live' check (mode in ('live', 'replay')),
  replay_run_id uuid references replay_runs (id)
);

create unique index events_dedupe_live
  on events (source, source_event_id) where mode = 'live';
create unique index events_dedupe_replay
  on events (source, source_event_id, replay_run_id) where mode = 'replay';

create table market_snapshots (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets (id),
  outcome_id uuid not null references market_outcomes (id),
  yes_price numeric,
  best_bid numeric,
  best_ask numeric,
  spread_bps integer,
  depth_usd numeric,
  provider text,
  provider_ref text,
  raw_payload jsonb,
  observed_at timestamptz not null,
  mode text not null default 'live' check (mode in ('live', 'replay')),
  replay_run_id uuid references replay_runs (id)
);

create index market_snapshots_outcome_observed
  on market_snapshots (outcome_id, observed_at desc);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id),
  title text,
  url text,
  excerpt text,
  content_hash text,
  source_tier text,
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  relevance real,
  confidence real,
  raw_payload jsonb
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references markets (id),
  event_id uuid references events (id),
  hermes_task_id text,
  specialist text,
  status text not null default 'running',
  mode text not null default 'live' check (mode in ('live', 'replay')),
  replay_run_id uuid references replay_runs (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric,
  error_code text,
  error_message text
);

create table run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs (id),
  name text not null,
  agent_role text,
  status text not null default 'running',
  attempt integer not null default 1,
  input_refs jsonb,
  output jsonb,
  source_refs jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  latency_ms integer,
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric,
  error_code text,
  error_message text,
  unique (run_id, name, attempt)
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs (id),
  market_id uuid not null references markets (id),
  outcome_id uuid not null references market_outcomes (id),
  action text not null check (action in ('notify', 'ignore', 'needs_review')),
  side text,
  confidence real,
  expected_move_bps integer,
  observed_move_bps integer,
  lag_bps integer,
  reason text,
  risk_flags text[] not null default '{}',
  baseline_snapshot_id uuid references market_snapshots (id),
  current_snapshot_id uuid references market_snapshots (id),
  scoring_policy_version text,
  created_at timestamptz not null default now()
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique references decisions (id),
  run_id uuid not null references agent_runs (id),
  market_id uuid not null references markets (id),
  message text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  entitlement_tier text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references alerts (id),
  channel text not null,
  destination text not null,
  idempotency_key text not null unique,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table outcome_jobs (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references alerts (id),
  horizon_minutes integer not null,
  scheduled_for timestamptz not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  last_error text,
  unique (alert_id, horizon_minutes)
);

create table outcomes (
  id uuid primary key default gen_random_uuid(),
  outcome_job_id uuid not null unique references outcome_jobs (id),
  alert_id uuid not null references alerts (id),
  snapshot_id uuid references market_snapshots (id),
  scheduled_for timestamptz not null,
  checked_at timestamptz not null,
  horizon_minutes integer not null,
  price_at_check numeric,
  signed_move_bps integer,
  eval_label text not null check (eval_label in ('correct', 'wrong', 'flat', 'invalid_data')),
  evaluation_policy_version text,
  notes text
);
