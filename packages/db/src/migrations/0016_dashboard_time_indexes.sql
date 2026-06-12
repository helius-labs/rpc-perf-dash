-- 0016_dashboard_time_indexes.sql — time-leading indexes for the slow dashboard
-- read paths.
--
-- Live-DB note: infra/scripts/build-time-indexes.ts builds these same indexes
-- with CREATE INDEX CONCURRENTLY (no write lock) and records this migration
-- as applied — use it instead of this file on a database under load.
--
-- Three hot queries filter on a TIME column that is not the leading column of
-- any existing index, so Postgres falls back to sequential scans:
--
--   samples            /status (funnel + per-cloud matrix), fleet-health, and
--                      recent-challenges aggregates filter `started_at` alone
--                      (GROUP BY worker_provider / worker_id / provider_id, no
--                      connection_mode/method/provider equality). Neither
--                      samples_dash_idx (leads connection_mode,method) nor
--                      samples_lookup_idx (leads provider_id) can serve a bare
--                      started_at range, so it seq-scans the ~1.9M-row daily
--                      partition.
--   challenges         recent-challenges + the challenges browser + /runs filter
--                      `generated_at` alone with ORDER BY generated_at DESC.
--                      challenges_status_idx / challenges_method_idx both lead
--                      with a non-time column, so neither serves it.
--   leaderboard_agg_*  fetchMethodLatency (apps/web/src/lib/leaderboard.ts)
--                      filters worker_provider='__all__' AND methodology_version
--                      AND window_start>? with NO geo; leaderboard_agg_*_read
--                      leads with `geo`, so it can't range-scan. Equality cols
--                      first (worker_provider, methodology_version), range last
--                      (window_start) — connection_mode/method are only in the
--                      GROUP BY, so adding them would push window_start off the
--                      prunable prefix for no gain.
--
-- NOTE: on the live production DB these are built with CREATE INDEX CONCURRENTLY
-- (per-partition + ATTACH for the partitioned `samples` table) to avoid locking
-- the continuous insert path — see infra/scripts/build-time-indexes.ts. This
-- migration's plain CREATE INDEX IF NOT EXISTS is the canonical definition for
-- fresh databases and is a no-op where the concurrent build already created them.

CREATE INDEX IF NOT EXISTS samples_started_at_idx
  ON samples (started_at);

CREATE INDEX IF NOT EXISTS challenges_generated_at_idx
  ON challenges (generated_at DESC);

CREATE INDEX IF NOT EXISTS leaderboard_agg_1h_method_latency
  ON leaderboard_agg_1h (worker_provider, methodology_version, window_start);
CREATE INDEX IF NOT EXISTS leaderboard_agg_1d_method_latency
  ON leaderboard_agg_1d (worker_provider, methodology_version, window_start);
