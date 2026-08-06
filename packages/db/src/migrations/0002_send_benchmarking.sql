-- 0002_send_benchmarking.sql — the transaction-SEND ("sends") archetype.
--
-- Adds a parallel benchmark to the read path: instead of consensus-scored RPC
-- responses, we broadcast real transactions through competing send paths and
-- score them against the chain (landed / reverted / not_landed / submit_error).
-- See docs/methodology.md § Transaction sends.
--
-- Every statement is idempotent (IF NOT EXISTS / OR REPLACE / guarded DO block)
-- so a re-run is a no-op, matching the 0001 convention. No extensions used.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Archetype discriminator on the shared control plane
--
-- The fan-out / claim / vantage machinery is archetype-agnostic and reused
-- unchanged; the worker branches on `archetype`, not `method`. Send challenges
-- ride the same `challenges` / `challenge_assignments` tables via sentinels
-- (method = 'send:<scenario>', synthetic commitment_hash, placeholder reference).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS archetype text NOT NULL DEFAULT 'read';
ALTER TABLE challenge_assignments
  ADD COLUMN IF NOT EXISTS archetype text NOT NULL DEFAULT 'read';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_archetype_chk') THEN
    ALTER TABLE challenges
      ADD CONSTRAINT challenges_archetype_chk CHECK (archetype IN ('read', 'send'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_archetype_chk') THEN
    ALTER TABLE challenge_assignments
      ADD CONSTRAINT assignments_archetype_chk CHECK (archetype IN ('read', 'send'));
  END IF;
END $$;

-- NOTE: a `challenges (archetype, generated_at DESC)` index is deliberately NOT
-- created here. Building an index on the large, live `challenges` table takes a
-- write-blocking lock (the documented "scale the generator to 0 first" landmine).
-- Send volume is low + gated, so the existing generated_at indexing suffices; if
-- archetype-filtered challenge scans ever get hot, add it later with CREATE INDEX
-- CONCURRENTLY during a generator pause (see docs/operations.md).

-- Expose archetype to workers (they only ever read through this view). Append
-- the new column at the end to keep CREATE OR REPLACE VIEW column-compatible.
CREATE OR REPLACE VIEW challenges_worker_view AS
SELECT
  id, method, params, bucket, commitment_hash,
  generated_at, expires_at, methodology_version, status, archetype
FROM challenges;

-- ════════════════════════════════════════════════════════════════════════
-- 2. send_pending — in-flight registry (UNPARTITIONED, PK = signature)
--
-- Short-lived (<~80s). The worker INSERTs a row before the HTTP send; the
-- confirm poll / reaper DELETE it at classification time via a single-winner
-- `DELETE ... RETURNING`. `slot_sent` is the worker's head slot AT SEND TIME —
-- stamped by the worker (not the confirm poll), so slot_latency = slot_landed −
-- slot_sent is accurate regardless of poll cadence (a poll-time stamp would lag
-- the actual send and could exceed slot_landed for fast lands).
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS send_pending (
  signature          text PRIMARY KEY,
  challenge_id       uuid NOT NULL,
  scenario           text NOT NULL,
  send_target        text NOT NULL,
  worker_provider    text NOT NULL DEFAULT 'aws',
  region             text NOT NULL,
  egress_path        text NOT NULL,
  sent_at            timestamptz NOT NULL,
  slot_sent          bigint,
  submit_latency_ms  integer,
  nonce_race_id      bigint,
  priority_fee       bigint NOT NULL,
  tip_amount         bigint NOT NULL DEFAULT 0,
  cu_requested       integer NOT NULL,
  pool_address       text,
  swap_direction     text,
  CONSTRAINT send_pending_scenario_chk
    CHECK (scenario IN ('transfer', 'raydium_swap', 'orca_swap')),
  CONSTRAINT send_pending_direction_chk
    CHECK (swap_direction IS NULL OR swap_direction IN ('forward', 'reverse'))
);
-- Reaper scans oldest-first.
CREATE INDEX IF NOT EXISTS send_pending_sent_at_idx ON send_pending (sent_at);
-- Idempotent self-heal: this migration is re-runnable, and CREATE TABLE IF NOT
-- EXISTS won't add a new column to a send_pending created by an earlier version
-- of this file — so add slot_sent explicitly (no-op once present).
ALTER TABLE send_pending ADD COLUMN IF NOT EXISTS slot_sent bigint;

-- ════════════════════════════════════════════════════════════════════════
-- 3. landing_tx_results — final classified rows (APPEND-ONLY, partitioned)
--
-- Written ONCE per tx at classification time (landed / reverted / not_landed /
-- submit_error). Append-only + partition-by-started_at, so there is never a
-- cross-partition UPDATE-by-signature scan.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS landing_tx_results (
  challenge_id            uuid NOT NULL,
  scenario                text NOT NULL,
  send_target             text NOT NULL,
  worker_provider         text NOT NULL DEFAULT 'aws',
  region                  text NOT NULL,
  egress_path             text NOT NULL,
  signature               text NOT NULL,
  outcome                 text NOT NULL,
  landed                  boolean NOT NULL,
  failed                  boolean NOT NULL DEFAULT false,
  submit_error            text,
  started_at              timestamptz NOT NULL,
  sent_at                 timestamptz NOT NULL,
  submit_latency_ms       integer,
  wall_latency_ms         integer,
  slot_sent               bigint,
  slot_landed             bigint,
  slot_latency            bigint,
  nonce_race_id           bigint,
  priority_fee            bigint NOT NULL,   -- in-effect adaptive fee for the tick
  tip_amount              bigint NOT NULL DEFAULT 0,
  cu_requested            integer NOT NULL,
  cu_used                 bigint,
  pool_address            text,
  swap_direction          text,
  methodology_version     smallint NOT NULL,
  CONSTRAINT send_outcome_chk
    CHECK (outcome IN ('landed', 'reverted', 'not_landed', 'submit_error')),
  CONSTRAINT landing_scenario_chk
    CHECK (scenario IN ('transfer', 'raydium_swap', 'orca_swap')),
  CONSTRAINT landing_direction_chk
    CHECK (swap_direction IS NULL OR swap_direction IN ('forward', 'reverse'))
) PARTITION BY RANGE (started_at);

CREATE INDEX IF NOT EXISTS landing_tx_results_rollup_idx
  ON landing_tx_results (send_target, scenario, worker_provider, region, started_at);
CREATE INDEX IF NOT EXISTS landing_tx_results_challenge_idx
  ON landing_tx_results (challenge_id);
CREATE INDEX IF NOT EXISTS landing_tx_results_started_at_idx
  ON landing_tx_results (started_at);

-- Bootstrap partitions: today + tomorrow for landing_tx_results. The generator's
-- daily partition cron (partitions.ts) extends the window forward and drops old
-- partitions past retention.
DO $$
DECLARE
  d date;
BEGIN
  FOR d IN SELECT generate_series(current_date, current_date + 1, interval '1 day')::date LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS landing_tx_results_%s PARTITION OF landing_tx_results FOR VALUES FROM (%L) TO (%L)',
      to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. landing_wallet_balances — low-balance alert feed (plain, low volume)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS landing_wallet_balances (
  started_at        timestamptz NOT NULL DEFAULT now(),
  region            text NOT NULL,
  target_name       text NOT NULL,
  balance_lamports  bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS landing_wallet_balances_idx
  ON landing_wallet_balances (target_name, started_at DESC);

-- ════════════════════════════════════════════════════════════════════════
-- 6. send_wallets — the persisted key registry (control plane)
--
-- Per-(send_target × scenario) signing keys, plus per-scenario nonce authority
-- and the benchmark master reference. Workers READ signing keys here (they are
-- NOT in Secrets Manager). Only the generator leader writes. `secret_ref` holds
-- the secret-managed keypair material reference / encrypted bytes.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS send_wallets (
  name         text PRIMARY KEY,       -- e.g. 'helius:transfer'
  pubkey       text NOT NULL,
  scenario     text,
  send_target  text,
  role         text NOT NULL,          -- 'payer' | 'nonce_authority' | 'nonce_account'
  secret_ref   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_wallets_role_chk
    CHECK (role IN ('payer', 'nonce_authority', 'nonce_account'))
);

-- ════════════════════════════════════════════════════════════════════════
-- 6b. send_service_status — readiness heartbeat for the confirm service.
--
-- The worker send lane gates on this: it must NOT dispatch until apps/confirm
-- reports ready (leader + polling loop live). A send fired while confirm is down
-- would be falsely reaped as not_landed. Asserted, not relied on via deploy order.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS send_service_status (
  service   text PRIMARY KEY,           -- e.g. 'confirm'
  ready     boolean NOT NULL DEFAULT false,
  beat_at   timestamptz NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════
-- 7. Send rollups + leaderboard precompute (populated on separate intervals)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS send_rollups_5m (
  send_target            text NOT NULL,
  scenario               text NOT NULL,
  worker_provider        text NOT NULL DEFAULT 'aws',
  region                 text NOT NULL,
  methodology_version    smallint NOT NULL,
  window_start           timestamptz NOT NULL,
  sample_count_total     integer NOT NULL,
  landed_count           integer NOT NULL,
  reverted_count         integer NOT NULL,
  not_landed_count       integer NOT NULL,
  submit_error_count     integer NOT NULL,
  landing_rate           real,
  slot_latency_p50       integer,
  slot_latency_p95       integer,
  wall_latency_p50       integer,
  wall_latency_p95       integer,
  cu_used_avg            real,
  cu_requested_avg       real,
  priority_fee_avg       bigint,   -- in-effect adaptive fee, for cross-time normalization
  PRIMARY KEY (send_target, scenario, worker_provider, region, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS send_rollups_5m_dash_idx
  ON send_rollups_5m (scenario, send_target, window_start);

-- Merged 1h + 1d tiers, distinguished by `grain` ('1h' | '1d').
CREATE TABLE IF NOT EXISTS send_rollups (
  LIKE send_rollups_5m INCLUDING DEFAULTS
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'send_rollups' AND column_name = 'grain'
  ) THEN
    ALTER TABLE send_rollups ADD COLUMN grain text NOT NULL DEFAULT '1h';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'send_rollups_pkey') THEN
    ALTER TABLE send_rollups ADD CONSTRAINT send_rollups_pkey
      PRIMARY KEY (grain, send_target, scenario, worker_provider, region, methodology_version, window_start);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'send_rollups_grain_chk') THEN
    ALTER TABLE send_rollups ADD CONSTRAINT send_rollups_grain_chk CHECK (grain IN ('1h', '1d'));
  END IF;
END $$;

-- Geo-blended leaderboard precompute (region → geo via GEO_REGION_MAP in code).
CREATE TABLE IF NOT EXISTS send_leaderboard_agg (
  grain                  text NOT NULL,
  geo                    text NOT NULL,
  worker_provider        text NOT NULL DEFAULT 'aws',
  send_target            text NOT NULL,
  scenario               text NOT NULL,
  methodology_version    smallint NOT NULL,
  window_start           timestamptz NOT NULL,
  sample_count_total     integer NOT NULL,
  landing_rate           real,
  slot_latency_p50       integer,
  slot_latency_p95       integer,
  wall_latency_p50       integer,
  wall_latency_p95       integer,
  cu_used_avg            real,
  cu_requested_avg       real,
  priority_fee_avg       bigint,
  PRIMARY KEY (grain, geo, worker_provider, send_target, scenario, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS send_leaderboard_agg_read_idx
  ON send_leaderboard_agg (grain, scenario, methodology_version, window_start);
