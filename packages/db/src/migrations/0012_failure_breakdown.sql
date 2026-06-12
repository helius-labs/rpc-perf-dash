-- 0012_failure_breakdown.sql
--
-- Per-failure-category counts at the leaderboard precompute grain, so the
-- dashboard can explain *why* a provider's success % is below 100 — a hover
-- breakdown on the success % anywhere it renders (leaderboard single + Overall,
-- provider hero, mobile cards).
--
-- Companion to leaderboard_agg_{1h,1d} (migration 0010), mirroring the
-- leaderboard_challenges_{1h,1d} pattern: same (geo, infra-or-'__all__',
-- provider, method, mode, mv, time-bucket) grain, plus failure_category, with a
-- per-category count.
--
-- Reconciliation invariant: these counts are produced under the EXACT same
-- predicate the precompute uses for sample_count_failed (scf) —
--   correctness != 'ambiguous' AND (status != 'ok' OR correctness != 'correct')
-- — so SUM(n) over a (geo, infra, provider, method, mode, mv) window equals
-- leaderboard_agg's sample_count_failed for the same key. That's exactly the
-- numerator behind success_rate_calls = 1 - failed/total, so the breakdown adds
-- up to the missing %.  (quorum_ambiguous samples are excluded by the predicate
-- and never appear here.)
--
-- Rows are emitted at two infra scopes (concrete worker_provider + '__all__')
-- via the same GROUPING SETS as the agg, written delete-then-insert each tick.

CREATE TABLE IF NOT EXISTS leaderboard_failures_1h (
  geo                   text     NOT NULL,
  worker_provider       text     NOT NULL,  -- concrete infra, or '__all__' (pooled)
  provider_id           text     NOT NULL,
  method                text     NOT NULL,
  connection_mode       text     NOT NULL,
  methodology_version   smallint NOT NULL,
  window_start          timestamptz NOT NULL,
  failure_category      text     NOT NULL,
  n                     integer  NOT NULL,
  PRIMARY KEY (geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, failure_category)
);
-- The read sums per provider over (geo, infra, method, mode, mv) + window_start
-- range across all providers; provider_id sits earlier in the PK, so add a
-- matching index to guarantee a range scan (mirrors leaderboard_agg_1h_read).
CREATE INDEX IF NOT EXISTS leaderboard_failures_1h_read
  ON leaderboard_failures_1h (geo, worker_provider, method, connection_mode, methodology_version, window_start);

CREATE TABLE IF NOT EXISTS leaderboard_failures_1d (
  geo                   text     NOT NULL,
  worker_provider       text     NOT NULL,
  provider_id           text     NOT NULL,
  method                text     NOT NULL,
  connection_mode       text     NOT NULL,
  methodology_version   smallint NOT NULL,
  window_start          timestamptz NOT NULL,
  failure_category      text     NOT NULL,
  n                     integer  NOT NULL,
  PRIMARY KEY (geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, failure_category)
);
CREATE INDEX IF NOT EXISTS leaderboard_failures_1d_read
  ON leaderboard_failures_1d (geo, worker_provider, method, connection_mode, methodology_version, window_start);
