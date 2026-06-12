-- 0010_long_window_perf.sql
--
-- Make 7d / 30d dashboard views load near-instantly without sacrificing
-- accuracy.
--
-- Problem: the leaderboard (apps/web/src/app/page.tsx) ranked providers by
-- exact correct-only percentiles + a DISTINCT ON win-count CTE computed from
-- raw `samples` over the whole window, once per geo (6x). On 30d that sorts
-- most of a tens-of-millions-of-rows table six times per filter click.
--
-- Naive fix (average the existing rollup percentiles) was rejected: rollup
-- percentiles are stored at a fine grain (provider x worker_provider x region
-- x difficulty-bucket x window, ~27 samples/cell) and averaging scalar
-- percentiles across such small heterogeneous cells distorts them badly
-- (measured: p50 +6..+22%, p95 -17..-30%, p99 -30..-49%).
--
-- Real fix: precompute the leaderboard's aggregates at exactly the grain the
-- FE reads — (geo, infra, provider, method, mode, methodology_version, time
-- bucket) — with the percentile computed over the POOLED geo samples per time
-- bucket (so each percentile is over enough samples to be meaningful). The
-- >24h read then weight-averages across time buckets only, leaving only the
-- benign time-averaging residual (a few %, same population). Win-counts are
-- computed exactly (global lowest-latency-per-challenge within the geo/infra)
-- and stored, so they stay accurate on all windows.
--
-- This migration adds:
--   * geo_region_map           — region->geo lookup, seeded from GEO_REGION_MAP
--                                (packages/shared/src/types.ts) by the generator
--                                so the SQL grouping can't drift from the FE.
--   * leaderboard_agg_{1h,1d}  — per-(geo, infra, provider, ...) aggregates +
--                                correct-only percentiles + n_wins per bucket.
--   * leaderboard_challenges_{1h,1d} — companion n_challenges (rate denominator)
--                                per (geo, infra, ...) bucket.
--   * indexes on rollups_1h/1d to support the now-tiered chart range scan.
--
-- No changes to rollups_5m/1h/1d themselves — the chart keeps reading their
-- existing all-samples latency_p95 (unchanged trend-viz behavior).

-- ─────────────────────────────────────────────────────────────────────────
-- region -> geo lookup (single source of truth = GEO_REGION_MAP, seeded by the
-- generator at startup/each tick; created empty here)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geo_region_map (
  worker_provider text NOT NULL,
  region          text NOT NULL,
  geo             text NOT NULL,
  PRIMARY KEY (worker_provider, region)
);

-- ─────────────────────────────────────────────────────────────────────────
-- leaderboard aggregates — hourly grain (feeds the 7d view)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_agg_1h (
  geo                   text     NOT NULL,
  worker_provider       text     NOT NULL,  -- concrete infra, or '__all__' (pooled)
  provider_id           text     NOT NULL,
  method                text     NOT NULL,
  connection_mode       text     NOT NULL,
  methodology_version   smallint NOT NULL,
  window_start          timestamptz NOT NULL,
  -- correct-only percentiles over the POOLED (geo[/infra], all difficulty
  -- buckets) samples in this time bucket
  latency_p50_correct   integer,
  latency_p95_correct   integer,
  latency_p99_correct   integer,
  latency_stddev        double precision,    -- stddev of correct latencies (approx over time)
  -- counts
  sample_count_valid    integer  NOT NULL,   -- correct count == percentile weight
  sample_count_total    integer  NOT NULL,
  sample_count_failed   integer  NOT NULL,
  honeypot_pass_count   integer  NOT NULL,
  honeypot_total        integer  NOT NULL,
  -- rate numerators/denominators (read computes exact ratios, never avg-of-rates)
  success_num           integer  NOT NULL,   -- status='ok' AND correctness != 'ambiguous'
  correctness_num       integer  NOT NULL,   -- status='ok' AND correctness='correct'
  correctness_den       integer  NOT NULL,   -- status='ok' AND correctness IN (correct,incorrect,stale)
  completeness_num      integer  NOT NULL,   -- correctness IN (correct,stale,incorrect)
  completeness_den      integer  NOT NULL,   -- correctness != 'ambiguous'
  freshness_p95_lag     integer,             -- p95 of freshness_lag over the pooled bucket
  n_wins                integer  NOT NULL DEFAULT 0,
  PRIMARY KEY (geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
);
-- The FE filters (geo, worker_provider, method, mode, mv) + window_start range
-- across all providers; provider_id sits earlier in the PK, so add a matching
-- index to guarantee a range scan.
CREATE INDEX IF NOT EXISTS leaderboard_agg_1h_read
  ON leaderboard_agg_1h (geo, worker_provider, method, connection_mode, methodology_version, window_start);

-- ─────────────────────────────────────────────────────────────────────────
-- leaderboard aggregates — daily grain (feeds the 30d view)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_agg_1d (
  geo                   text     NOT NULL,
  worker_provider       text     NOT NULL,
  provider_id           text     NOT NULL,
  method                text     NOT NULL,
  connection_mode       text     NOT NULL,
  methodology_version   smallint NOT NULL,
  window_start          timestamptz NOT NULL,
  latency_p50_correct   integer,
  latency_p95_correct   integer,
  latency_p99_correct   integer,
  latency_stddev        double precision,
  sample_count_valid    integer  NOT NULL,
  sample_count_total    integer  NOT NULL,
  sample_count_failed   integer  NOT NULL,
  honeypot_pass_count   integer  NOT NULL,
  honeypot_total        integer  NOT NULL,
  success_num           integer  NOT NULL,
  correctness_num       integer  NOT NULL,
  correctness_den       integer  NOT NULL,
  completeness_num      integer  NOT NULL,
  completeness_den      integer  NOT NULL,
  freshness_p95_lag     integer,
  n_wins                integer  NOT NULL DEFAULT 0,
  PRIMARY KEY (geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
);
CREATE INDEX IF NOT EXISTS leaderboard_agg_1d_read
  ON leaderboard_agg_1d (geo, worker_provider, method, connection_mode, methodology_version, window_start);

-- ─────────────────────────────────────────────────────────────────────────
-- companion challenge counts (rate denominator: challenges with any winner)
-- PK already matches the read pattern exactly — no extra index.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leaderboard_challenges_1h (
  geo                   text     NOT NULL,
  worker_provider       text     NOT NULL,
  method                text     NOT NULL,
  connection_mode       text     NOT NULL,
  methodology_version   smallint NOT NULL,
  window_start          timestamptz NOT NULL,
  n_challenges          integer  NOT NULL,
  PRIMARY KEY (geo, worker_provider, method, connection_mode, methodology_version, window_start)
);

CREATE TABLE IF NOT EXISTS leaderboard_challenges_1d (
  geo                   text     NOT NULL,
  worker_provider       text     NOT NULL,
  method                text     NOT NULL,
  connection_mode       text     NOT NULL,
  methodology_version   smallint NOT NULL,
  window_start          timestamptz NOT NULL,
  n_challenges          integer  NOT NULL,
  PRIMARY KEY (geo, worker_provider, method, connection_mode, methodology_version, window_start)
);

-- ─────────────────────────────────────────────────────────────────────────
-- chart range-scan indexes (rollups are now read tiered: 7d→1h, 30d→1d)
-- The PK leads with provider_id, so a window_start range across providers
-- can't prune on it; these match the chart's WHERE shape.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS rollups_1h_chart_read
  ON rollups_1h (connection_mode, methodology_version, method, window_start);
CREATE INDEX IF NOT EXISTS rollups_1d_chart_read
  ON rollups_1d (connection_mode, methodology_version, method, window_start);
