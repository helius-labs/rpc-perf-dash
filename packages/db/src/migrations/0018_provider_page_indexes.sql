-- 0018_provider_page_indexes.sql — provider-selective indexes for the
-- /provider/[id] read paths.
--
-- Live-DB note: infra/scripts/build-provider-page-indexes.ts builds these same
-- indexes with CREATE INDEX CONCURRENTLY (no write lock) and records this
-- migration as applied — use it instead of this file on a database under load.
--
-- The provider detail page runs three single-provider, last-24h queries that no
-- existing index can serve selectively, so each one over-reads:
--
--   rollups_5m   fetchLatencySeries (apps/web/src/lib/chartData.ts) for the
--                provider chart filters provider_id + connection_mode + method
--                + window_start>24h. The only usable index is
--                rollups_5m_dash_idx (connection_mode, method, window_start),
--                which matches EVERY provider for the window (~141k index rows →
--                ~14k scattered heap pages) and only then filters to the one
--                provider — ~38s cold on Neon.
--   rollups_1h   fetchMethodBreakdown (apps/web/src/app/provider/[id]/page.tsx)
--                filters provider_id + methodology_version + window_start>24h.
--                The PK leads with provider_id but trails window_start, so it
--                scans the provider's ENTIRE rollup history to keep 24h (~10s).
--
-- (The provider failure breakdown was the third slow query; it now reads the
-- pre-aggregated leaderboard_failures_1h rollup instead of raw `samples`, so it
-- needs no samples index — a partial index there would cost a ~2h per-partition
-- CONCURRENTLY build for marginal gain.)
--
-- These indexes put the equality columns first and the time range last, so each
-- query range-scans only its provider's last-24h rows.
--
-- NOTE: on the live production DB these are built with CREATE INDEX CONCURRENTLY
-- (rollups_* are not partitioned, so a direct concurrent build — see
-- infra/scripts/build-provider-page-indexes.ts) to avoid locking the rollup
-- writer's upsert path. This migration's plain CREATE INDEX IF NOT EXISTS is the
-- canonical definition for fresh databases and is a no-op where the concurrent
-- build already created them.

CREATE INDEX IF NOT EXISTS rollups_5m_provider_chart_idx
  ON rollups_5m (provider_id, connection_mode, method, window_start);

CREATE INDEX IF NOT EXISTS rollups_1h_provider_window_idx
  ON rollups_1h (provider_id, methodology_version, window_start);
