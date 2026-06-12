-- 0003_drop_tdigest.sql
--
-- Neon's allowed-extensions list does not include `tdigest`, so we replace
-- the tdigest-based quantile composition with:
--   - Scalar p50/p95/p99 columns on rollups (computed in-cron from samples
--     via percentile_cont).
--   - Leaderboard reads percentiles directly from `samples` (POC volume is
--     ~17k samples/day single-region; native percentile_cont is fine).
--
-- Methodology consequence: weighted workload-mix quantiles are no longer
-- exactly composable from rollups. Dashboard reads from samples for the
-- leaderboard view, which gives exact percentiles. Drilldown views fall
-- back to averaging pre-aggregated p95 across buckets — labeled
-- "approximate" in the UI.

-- Drop tdigest column + extension dep.
ALTER TABLE rollups_5m DROP COLUMN IF EXISTS latency_digest;
ALTER TABLE rollups_1h DROP COLUMN IF EXISTS latency_digest;
ALTER TABLE rollups_1d DROP COLUMN IF EXISTS latency_digest;

-- Scalar percentiles per rollup bucket. (IF NOT EXISTS so fresh deploys
-- where 0001 already creates these columns are no-ops.)
ALTER TABLE rollups_5m ADD COLUMN IF NOT EXISTS latency_p50 integer;
ALTER TABLE rollups_5m ADD COLUMN IF NOT EXISTS latency_p95 integer;
ALTER TABLE rollups_5m ADD COLUMN IF NOT EXISTS latency_p99 integer;
ALTER TABLE rollups_1h ADD COLUMN IF NOT EXISTS latency_p50 integer;
ALTER TABLE rollups_1h ADD COLUMN IF NOT EXISTS latency_p95 integer;
ALTER TABLE rollups_1h ADD COLUMN IF NOT EXISTS latency_p99 integer;
ALTER TABLE rollups_1d ADD COLUMN IF NOT EXISTS latency_p50 integer;
ALTER TABLE rollups_1d ADD COLUMN IF NOT EXISTS latency_p95 integer;
ALTER TABLE rollups_1d ADD COLUMN IF NOT EXISTS latency_p99 integer;
