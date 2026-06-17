-- 0023_provider_breakdown_index.sql — provider-leading index on
-- leaderboard_agg_1h for the /provider/[id] section-04 "Latency by method" read.
--
-- Live-DB note: infra/scripts/build-provider-breakdown-index.ts builds this same
-- index with CREATE INDEX CONCURRENTLY (no write lock) and records this migration
-- as applied — use it instead of this file on a database under load.
--
-- The provider page's per-method p50 query reads the pooled (worker_provider =
-- '__all__') leaderboard_agg_1h rows for ONE provider over the last 24h. The
-- existing indexes lead with geo / worker_provider (PK and leaderboard_agg_1h_read
-- from 0010, leaderboard_agg_1h_method_latency from 0016), none of which lead with
-- provider_id — so a single-provider read scans every provider's __all__ rows for
-- the window (~109k index rows → ~25k scattered heap blocks) and only then filters
-- to the one provider.
--
-- This index puts all equality columns of that query first and the single range
-- column (window_start) last, so it range-scans only the provider's last-24h rows:
--   provider_id        = ${id}              (equality, most selective)
--   worker_provider    = '__all__'          (equality, pins the pooled sentinel)
--   connection_mode    = 'cold'             (equality)
--   methodology_version = <current>         (equality)
--   window_start       > now() - 24h        (range — MUST be last to stay a bound)
-- `method` is intentionally omitted: it has no equality predicate (GROUP BY only),
-- so placing it before window_start would break the equality prefix and demote
-- window_start to an in-index filter (the rollups_1h_provider_window_idx bug). The
-- GROUP BY over the ~hundreds of matched rows sorts cheaply in memory.
--
-- NOTE: on the live production DB this is built with CREATE INDEX CONCURRENTLY
-- (leaderboard_agg_1h is not partitioned — see
-- infra/scripts/build-provider-breakdown-index.ts) to avoid locking the rollup
-- writer's upsert path. This migration's plain CREATE INDEX IF NOT EXISTS is the
-- canonical definition for fresh databases and is a no-op where the concurrent
-- build already created it.

CREATE INDEX IF NOT EXISTS leaderboard_agg_1h_provider_method_idx
  ON leaderboard_agg_1h
  (provider_id, worker_provider, connection_mode, methodology_version, window_start);
