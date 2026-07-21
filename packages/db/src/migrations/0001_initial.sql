-- 0001_initial.sql — full baseline schema.
--
-- Owned by hand because Drizzle does not support native partitioning, the
-- partitioned `samples` / `samples_archived` tables, the worker-facing view, or
-- the CHECK constraints below. Apply via `pnpm db:migrate` (which runs
-- migrate.ts). Every statement is idempotent (IF NOT EXISTS / OR REPLACE) so a
-- re-run is a no-op.
--
-- No Postgres extensions are used: quantiles use scalar percentile columns +
-- native percentile_cont(), because managed Postgres providers commonly
-- disallow custom extensions like tdigest.

-- ════════════════════════════════════════════════════════════════════════
-- Control plane
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS challenges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method               text NOT NULL,
  params               jsonb NOT NULL,
  bucket               text NOT NULL,
  commitment_hash      bytea NOT NULL,
  seed_revealed_at     timestamptz,
  seed                 bytea,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  reference_response   jsonb,
  reference_hash       bytea,
  reference_tip_slot   bigint,
  methodology_version  smallint NOT NULL,
  status               text NOT NULL,
  is_honeypot          boolean NOT NULL DEFAULT false,
  run_id               uuid,
  has_samples          boolean NOT NULL DEFAULT false,
  CONSTRAINT challenges_status_chk CHECK (status IN ('ready', 'expired'))
);
CREATE INDEX IF NOT EXISTS challenges_status_idx ON challenges (status, generated_at);
CREATE INDEX IF NOT EXISTS challenges_method_idx ON challenges (method, generated_at);
CREATE INDEX IF NOT EXISTS challenges_generated_at_idx ON challenges (generated_at DESC);
CREATE INDEX IF NOT EXISTS challenges_bucket_idx ON challenges (bucket text_pattern_ops, generated_at DESC);
CREATE INDEX IF NOT EXISTS challenges_run_id_idx ON challenges (run_id, generated_at DESC) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS challenges_expiry_candidates_idx ON challenges (expires_at) WHERE status = 'ready' AND has_samples = false;
CREATE INDEX IF NOT EXISTS challenges_ref_pending_idx ON challenges (generated_at) WHERE reference_response IS NOT NULL;
CREATE INDEX IF NOT EXISTS challenges_seed_reveal_pending_idx ON challenges (expires_at) WHERE seed_revealed_at IS NULL AND seed IS NOT NULL;

-- Extended statistics: status and has_samples are highly correlated, so the
-- planner needs the joint distribution to size the stale-expiry scan.
CREATE STATISTICS IF NOT EXISTS challenges_status_has_samples (mcv)
  ON status, has_samples FROM challenges;

-- View that hides is_honeypot from workers. Workers MUST query this view, not
-- the base table, so honeypots are indistinguishable from regular challenges at
-- execution time.
CREATE OR REPLACE VIEW challenges_worker_view AS
SELECT
  id, method, params, bucket, commitment_hash,
  generated_at, expires_at, methodology_version, status
FROM challenges;

CREATE TABLE IF NOT EXISTS challenge_assignments (
  challenge_id     uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  region           text NOT NULL,
  egress_path      text NOT NULL,
  claimed_at       timestamptz,
  completed_at     timestamptz,
  status           text NOT NULL DEFAULT 'unclaimed',
  worker_id        text,
  worker_provider  text NOT NULL DEFAULT 'aws',
  PRIMARY KEY (challenge_id, worker_provider, region, egress_path),
  CONSTRAINT assignments_status_chk
    CHECK (status IN ('unclaimed', 'claimed', 'done', 'expired'))
);
CREATE INDEX IF NOT EXISTS assignments_claim_idx
  ON challenge_assignments (worker_provider, region, egress_path, status);
CREATE INDEX IF NOT EXISTS assignments_claimed_at_idx
  ON challenge_assignments (claimed_at);
CREATE INDEX IF NOT EXISTS challenge_assignments_unclaimed_idx
  ON challenge_assignments (challenge_id) WHERE status = 'unclaimed';

CREATE TABLE IF NOT EXISTS providers (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  benchmarked      boolean NOT NULL,
  utility          boolean NOT NULL,
  tier_name        text NOT NULL,
  retention_slots  text NOT NULL,
  monthly_cap      bigint,
  config           jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS eligibility (
  provider_id            text NOT NULL REFERENCES providers(id),
  region                 text NOT NULL,
  method                 text NOT NULL,
  methodology_version    smallint NOT NULL,
  window_end             timestamptz NOT NULL,
  eligible               boolean NOT NULL,
  failing_reason         text,
  n_valid                integer NOT NULL,
  reliability            real NOT NULL,
  correctness            real NOT NULL,
  honeypot_pass_rate_lb  real NOT NULL,
  PRIMARY KEY (provider_id, region, method, methodology_version, window_end)
);
CREATE INDEX IF NOT EXISTS eligibility_window_end_idx ON eligibility (window_end);

CREATE TABLE IF NOT EXISTS generator_heartbeat (
  id        integer PRIMARY KEY DEFAULT 1,
  pid       integer NOT NULL,
  hostname  text NOT NULL,
  beat_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeat (
  worker_id        text PRIMARY KEY,
  region           text NOT NULL,
  egress_path      text NOT NULL,
  pid              integer NOT NULL,
  beat_at          timestamptz NOT NULL DEFAULT now(),
  worker_provider  text NOT NULL DEFAULT 'aws'
);

CREATE TABLE IF NOT EXISTS honeypot_pool (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method                   text NOT NULL,
  params                   jsonb NOT NULL,
  expected_projection_hash bytea NOT NULL,
  expected_projection      jsonb NOT NULL,
  methodology_version      smallint NOT NULL,
  last_used_at             timestamptz,
  use_count                integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS honeypot_lru_idx
  ON honeypot_pool (method, last_used_at NULLS FIRST);

-- Per-endpoint health snapshot for the generator's utility-RPC client (the
-- endpoint used for challenge derivation + honeypot seeding).
CREATE TABLE IF NOT EXISTS utility_rpc_status (
  endpoint_index  integer PRIMARY KEY,
  url_label       text NOT NULL,
  last_ok_at      timestamptz,
  last_err_at     timestamptz,
  last_err_msg    text,
  consec_fails    integer NOT NULL DEFAULT 0,
  circuit_state   text NOT NULL DEFAULT 'closed',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT utility_rpc_status_circuit_state_check
    CHECK (circuit_state IN ('closed', 'open', 'half-open'))
);

-- ════════════════════════════════════════════════════════════════════════
-- Consensus
-- ════════════════════════════════════════════════════════════════════════

-- Per-challenge × vantage × mode consensus decision. One row per
-- (challenge_id, worker_provider, region, egress_path, connection_mode), but
-- only for *interesting* groups (archive-sampled or honeypot) — full
-- per-vantage-per-mode logging would explode the row count.
CREATE TABLE IF NOT EXISTS consensus_log (
  challenge_id     uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  worker_provider  text NOT NULL,
  region           text NOT NULL,
  egress_path      text NOT NULL,
  connection_mode  text NOT NULL,
  voters           jsonb NOT NULL,
  decision         text NOT NULL,
  decision_reason  text,
  dissenters       jsonb,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, worker_provider, region, egress_path, connection_mode)
);
CREATE INDEX IF NOT EXISTS consensus_log_decided_idx ON consensus_log (decided_at);

-- ════════════════════════════════════════════════════════════════════════
-- Hot path — samples (partitioned daily by started_at)
--
-- The generator's daily partition cron extends the window forward and drops
-- partitions older than the retention horizon. We ship the partitioned parent
-- plus a today/tomorrow partition pair so workers can write immediately.
-- Indexes are created on the partitioned parent, so they propagate to every
-- current and future partition automatically.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS samples (
  challenge_id         uuid NOT NULL,
  method               text NOT NULL,
  provider_id          text NOT NULL,
  region               text NOT NULL,
  worker_id            text NOT NULL,
  egress_path          text NOT NULL,
  endpoint_used        text NOT NULL,  -- host-only label; never the full URL (can embed API keys)
  bucket               text NOT NULL,
  connection_mode      text NOT NULL,
  started_at           timestamptz NOT NULL,
  latency_ms           integer NOT NULL,
  status               text NOT NULL,
  error_code           text,
  http_status          smallint,
  response_hash        bytea NOT NULL,
  provider_tip_slot    bigint,
  reference_tip_slot   bigint,
  response_slot        bigint,
  freshness_lag        bigint,
  correctness          text NOT NULL,
  exclusion_reason     text,
  methodology_version  smallint NOT NULL,
  is_honeypot          boolean NOT NULL DEFAULT false,
  raw_response         jsonb,
  failure_category     text,
  failure_detail       text,
  worker_provider      text NOT NULL DEFAULT 'aws',
  CONSTRAINT samples_status_chk CHECK (status IN ('ok', 'error', 'timeout')),
  CONSTRAINT samples_mode_chk CHECK (connection_mode IN ('cold', 'warm')),
  CONSTRAINT samples_correctness_chk
    CHECK (correctness IN ('correct', 'incorrect', 'incomplete', 'stale', 'ambiguous')),
  CONSTRAINT samples_exclusion_chk CHECK (
    exclusion_reason IS NULL OR exclusion_reason IN (
      'tier_archive_unavailable', 'tier_method_unsupported',
      'no_consensus', 'freshness_stale', 'correctness_failure', 'reliability_failure',
      -- no-fault exclusions (excluded from BOTH correctness and reliability):
      -- freshness_ahead = mutable-value divergence where the provider read a
      -- strictly newer slot than the panel; operational_error = operator-side
      -- quota/rate-limit (own billing cap). See packages/shared/src/types.ts.
      'freshness_ahead', 'operational_error'
    )
  )
) PARTITION BY RANGE (started_at);

CREATE INDEX IF NOT EXISTS samples_lookup_idx
  ON samples (provider_id, method, worker_provider, region, connection_mode, started_at);
CREATE INDEX IF NOT EXISTS samples_challenge_idx ON samples (challenge_id);
CREATE INDEX IF NOT EXISTS samples_dash_idx ON samples (connection_mode, method, started_at);
CREATE INDEX IF NOT EXISTS samples_failure_category_idx
  ON samples (provider_id, failure_category, started_at DESC) WHERE failure_category IS NOT NULL;
-- Create the honeypot partial index before the plain started_at index: both
-- derive per-partition names from "started_at", and this ordering reproduces the
-- historical name assignment (…_started_at_idx vs …_started_at_idx1).
CREATE INDEX IF NOT EXISTS samples_honeypot_idx ON samples (started_at) WHERE is_honeypot;
CREATE INDEX IF NOT EXISTS samples_started_at_idx ON samples (started_at);

-- ════════════════════════════════════════════════════════════════════════
-- Archive — samples_archived (partitioned daily by started_at)
--
-- Holds sampled/retained rows past the live-partition horizon. No volatile
-- CHECK constraints (they'd block re-inserting historical vocabulary), and no
-- failure_category/failure_detail columns.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS samples_archived (
  challenge_id         uuid NOT NULL,
  method               text NOT NULL,
  provider_id          text NOT NULL,
  region               text NOT NULL,
  worker_id            text NOT NULL,
  egress_path          text NOT NULL,
  endpoint_used        text NOT NULL,
  bucket               text NOT NULL,
  connection_mode      text NOT NULL,
  started_at           timestamptz NOT NULL,
  latency_ms           integer NOT NULL,
  status               text NOT NULL,
  error_code           text,
  http_status          smallint,
  response_hash        bytea NOT NULL,
  provider_tip_slot    bigint,
  reference_tip_slot   bigint,
  response_slot        bigint,
  freshness_lag        bigint,
  correctness          text NOT NULL,
  exclusion_reason     text,
  methodology_version  smallint NOT NULL,
  is_honeypot          boolean NOT NULL DEFAULT false,
  raw_response         jsonb,
  worker_provider      text NOT NULL DEFAULT 'aws'
) PARTITION BY RANGE (started_at);

CREATE INDEX IF NOT EXISTS samples_archived_provider_id_method_region_connection_mode__idx
  ON samples_archived (provider_id, method, region, connection_mode, started_at);
CREATE INDEX IF NOT EXISTS samples_archived_challenge_id_idx
  ON samples_archived (challenge_id);
CREATE INDEX IF NOT EXISTS samples_archived_started_at_idx
  ON samples_archived (started_at) WHERE is_honeypot;

-- Bootstrap partitions: today + tomorrow for both partitioned tables. The
-- generator's daily partition cron extends the window forward and drops old
-- partitions past retention.
DO $$
DECLARE
  d date := current_date;
BEGIN
  FOR d IN SELECT generate_series(current_date, current_date + 1, interval '1 day')::date LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS samples_%s PARTITION OF samples FOR VALUES FROM (%L) TO (%L)',
      to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
    );
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS samples_archived_%s PARTITION OF samples_archived FOR VALUES FROM (%L) TO (%L)',
      to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- Rollups — populated by the 5-minute rollup cron
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rollups_5m (
  provider_id            text NOT NULL,
  method                 text NOT NULL,
  region                 text NOT NULL,
  bucket                 text NOT NULL,
  connection_mode        text NOT NULL,
  methodology_version    smallint NOT NULL,
  window_start           timestamptz NOT NULL,
  sample_count_total     integer NOT NULL,
  sample_count_valid     integer NOT NULL,
  sample_count_excluded  integer NOT NULL,
  exclusion_breakdown    jsonb,
  latency_p50            integer,
  latency_p95            integer,
  latency_p99            integer,
  latency_stddev         double precision,
  success_rate           real,
  correctness_rate       real,
  completeness_rate      real,
  freshness_avg_lag      real,
  freshness_p95_lag      integer,
  honeypot_pass_count    integer,
  honeypot_total         integer,
  worker_provider        text NOT NULL DEFAULT 'aws',
  PRIMARY KEY (provider_id, method, worker_provider, region, bucket, connection_mode, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS rollups_5m_dash_idx
  ON rollups_5m (connection_mode, method, window_start);
CREATE INDEX IF NOT EXISTS rollups_5m_provider_chart_idx
  ON rollups_5m (provider_id, connection_mode, method, window_start);

-- rollups: merged 1h + 1d tiers, distinguished by `grain` ('1h' | '1d'). The
-- hot 5-minute tier keeps its own table (rollups_5m) to avoid mixing its
-- high-churn UPSERTs into the cold long-window indexes. Every read pins exactly
-- one grain, so the grain-led PK/indexes give the same single-grain index seeks
-- the two separate tables did.
CREATE TABLE IF NOT EXISTS rollups (
  grain text NOT NULL,
  LIKE rollups_5m INCLUDING DEFAULTS,
  PRIMARY KEY (grain, provider_id, method, worker_provider, region, bucket, connection_mode, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS rollups_dash_idx
  ON rollups (grain, connection_mode, method, window_start);
CREATE INDEX IF NOT EXISTS rollups_chart_read
  ON rollups (grain, connection_mode, methodology_version, method, window_start);
CREATE INDEX IF NOT EXISTS rollups_provider_window_idx
  ON rollups (grain, provider_id, methodology_version, window_start);

-- ════════════════════════════════════════════════════════════════════════
-- Leaderboard aggregates — geo-blended precompute for the dashboard
-- Each table below merges its former _1h + _1d pair; `grain` ('1h' | '1d')
-- leads the PK and every index so single-grain reads still seek, not scan.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leaderboard_agg (
  grain                text NOT NULL,
  geo                  text NOT NULL,
  worker_provider      text NOT NULL,
  provider_id          text NOT NULL,
  method               text NOT NULL,
  connection_mode      text NOT NULL,
  methodology_version  smallint NOT NULL,
  window_start         timestamptz NOT NULL,
  latency_p50_correct  integer,
  latency_p95_correct  integer,
  latency_p99_correct  integer,
  latency_stddev       double precision,
  sample_count_valid   integer NOT NULL,
  sample_count_total   integer NOT NULL,
  sample_count_failed  integer NOT NULL,
  honeypot_pass_count  integer NOT NULL,
  honeypot_total       integer NOT NULL,
  success_num          integer NOT NULL,
  correctness_num      integer NOT NULL,
  correctness_den      integer NOT NULL,
  completeness_num     integer NOT NULL,
  completeness_den     integer NOT NULL,
  freshness_p95_lag    integer,
  n_wins               integer NOT NULL DEFAULT 0,
  -- No-fault-excluded sample count (exclusion_reason IN ('freshness_ahead',
  -- 'operational_error')) — the web leaderboard subtracts this from the
  -- reliability denominator so those rows are out of BOTH correctness and
  -- reliability. Written by insertLeaderboardAgg.
  nofault_excluded_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS leaderboard_agg_read
  ON leaderboard_agg (grain, geo, worker_provider, method, connection_mode, methodology_version, window_start);
CREATE INDEX IF NOT EXISTS leaderboard_agg_method_latency
  ON leaderboard_agg (grain, worker_provider, methodology_version, window_start);
CREATE INDEX IF NOT EXISTS leaderboard_agg_provider_method_idx
  ON leaderboard_agg (grain, provider_id, worker_provider, connection_mode, methodology_version, window_start);

CREATE TABLE IF NOT EXISTS leaderboard_challenges (
  grain                text NOT NULL,
  geo                  text NOT NULL,
  worker_provider      text NOT NULL,
  method               text NOT NULL,
  connection_mode      text NOT NULL,
  methodology_version  smallint NOT NULL,
  window_start         timestamptz NOT NULL,
  n_challenges         integer NOT NULL,
  PRIMARY KEY (grain, geo, worker_provider, method, connection_mode, methodology_version, window_start)
);

CREATE TABLE IF NOT EXISTS leaderboard_failures (
  grain                text NOT NULL,
  geo                  text NOT NULL,
  worker_provider      text NOT NULL,
  provider_id          text NOT NULL,
  method               text NOT NULL,
  connection_mode      text NOT NULL,
  methodology_version  smallint NOT NULL,
  window_start         timestamptz NOT NULL,
  failure_category     text NOT NULL,
  n                    integer NOT NULL,
  PRIMARY KEY (grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, failure_category)
);
CREATE INDEX IF NOT EXISTS leaderboard_failures_read
  ON leaderboard_failures (grain, geo, worker_provider, method, connection_mode, methodology_version, window_start);

CREATE TABLE IF NOT EXISTS latency_histogram (
  grain                text NOT NULL,
  geo                  text NOT NULL,
  worker_provider      text NOT NULL,
  provider_id          text NOT NULL,
  method               text NOT NULL,
  connection_mode      text NOT NULL,
  methodology_version  smallint NOT NULL,
  window_start         timestamptz NOT NULL,
  bins                 jsonb NOT NULL,
  n                    integer NOT NULL,
  min_ms               integer,
  PRIMARY KEY (grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS latency_histogram_read
  ON latency_histogram (grain, worker_provider, method, connection_mode, window_start);

-- Head-to-head (A-vs-B) win-rate precompute. The leaderboard's n_wins is
-- winner-take-all across the whole panel, so it cannot answer "did provider A
-- beat provider B". This table records, per time bucket / geo / method / mode /
-- methodology_version, the per-pair outcome of every challenge that BOTH
-- providers answered correctly: a_wins/b_wins are the faster-latency (ties →
-- earlier started_at) counts for the alphabetically-first / -second provider id,
-- and n_contested is the challenge count (= a_wins + b_wins by construction).
-- Written by insertPairwiseWins alongside leaderboard_agg. No worker_provider
-- dimension: pairwise is inherently cross-infra (the '__all__' scope), stored per
-- geo. Retention mirrors leaderboard_agg (1h → 8d, 1d → 31d) via pruneLeaderboard.
CREATE TABLE IF NOT EXISTS pairwise_wins (
  grain                text NOT NULL,
  geo                  text NOT NULL,
  provider_a           text NOT NULL,
  provider_b           text NOT NULL,
  method               text NOT NULL,
  connection_mode      text NOT NULL,
  methodology_version  smallint NOT NULL,
  window_start         timestamptz NOT NULL,
  a_wins               integer NOT NULL DEFAULT 0,
  b_wins               integer NOT NULL DEFAULT 0,
  n_contested          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (grain, geo, provider_a, provider_b, method, connection_mode, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS pairwise_wins_read
  ON pairwise_wins (grain, provider_a, provider_b, method, connection_mode, methodology_version, window_start);
