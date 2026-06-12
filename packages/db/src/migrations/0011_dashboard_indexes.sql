-- Dashboard read-path indexes.
--
-- Live-DB note: infra/scripts/build-dashboard-indexes.ts builds these same
-- indexes with CREATE INDEX CONCURRENTLY (no write lock) and records this
-- migration as applied — use it instead of this file on a database under load.
--
-- The hot dashboard queries aggregate ACROSS providers (GROUP BY provider_id),
-- so they never constrain provider_id — which makes the existing
-- provider_id-leading indexes (samples_lookup_idx, rollups_*_pkey) unusable for
-- them. Postgres fell back to sequential scans of millions of rows:
--   chart       (rollups_5m): seq scan ~1.5M rows to return ~68 (~0.6-1.3s)
--   leaderboard (samples):    seq scan the ~1.9M-row current-day partition
--                             (~1.6s), run twice per geo × up to 6 geos/render.
-- This surfaced as slow filter switches and the chart's Suspense boundary
-- timing out ("could not finish this Suspense boundary").
--
-- These indexes match the actual filter shape — equality on connection_mode +
-- method, range on the time column:
--   WHERE connection_mode = ? AND method = ? AND <time_col> > ?
--
-- `samples` is partitioned by day; the index on the parent propagates to all
-- existing and future daily partitions.
--
-- NOTE: on the live production DB these were built with CREATE INDEX
-- CONCURRENTLY (per-partition + ATTACH for the partitioned `samples` table) to
-- avoid locking the continuous sample-insert path — see
-- infra/scripts/build-dashboard-indexes.ts. This migration's plain
-- CREATE INDEX IF NOT EXISTS is the canonical definition for fresh databases and
-- is a no-op where the concurrent build already created them.

CREATE INDEX IF NOT EXISTS samples_dash_idx
  ON samples (connection_mode, method, started_at);

CREATE INDEX IF NOT EXISTS rollups_5m_dash_idx
  ON rollups_5m (connection_mode, method, window_start);
CREATE INDEX IF NOT EXISTS rollups_1h_dash_idx
  ON rollups_1h (connection_mode, method, window_start);
CREATE INDEX IF NOT EXISTS rollups_1d_dash_idx
  ON rollups_1d (connection_mode, method, window_start);
