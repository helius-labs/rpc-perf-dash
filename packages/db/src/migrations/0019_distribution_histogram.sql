-- Precomputed latency-distribution histograms.
--
-- The Performance page's "Latency distribution" metric (CDF / histogram / box)
-- previously read the raw `samples` table with percentile_cont + width_bucket,
-- which scanned ~67MB of heap per 6h query (~2-11s, worse cold). These tables
-- let the generator precompute, per rollup bucket, a 60-bin log-spaced histogram
-- (+ count + exact min) per (geo, infra-or-'__all__', provider, method, mode).
-- Bin counts are ADDITIVE across buckets, so a window read just sums the JSONB
-- bin maps and reconstructs density / CDF / box — ~10-50ms at any window.
--
-- `bins` is a sparse JSONB map { "<bin 1..60>": count }. Bin domain is shared in
-- packages/shared/src/histogram.ts (2ms..2000ms, 60 log bins; tails clamp into
-- the edge bins so SUM(bins) == n). `min_ms` is the exact minimum (the box
-- whisker's left end; the histogram floor bin only gives a range).
--
-- 1h feeds windows ≤7d, 1d feeds longer windows (mirrors leaderboard_agg_*).
-- 30-day retention is enforced by the generator's pruneLeaderboard.

CREATE TABLE IF NOT EXISTS latency_histogram_1h (
  geo                 text       NOT NULL,
  worker_provider     text       NOT NULL,
  provider_id         text       NOT NULL,
  method              text       NOT NULL,
  connection_mode     text       NOT NULL,
  methodology_version smallint   NOT NULL,
  window_start        timestamptz NOT NULL,
  bins                jsonb      NOT NULL,
  n                   integer    NOT NULL,
  min_ms              integer,
  PRIMARY KEY (geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
);

CREATE TABLE IF NOT EXISTS latency_histogram_1d (
  geo                 text       NOT NULL,
  worker_provider     text       NOT NULL,
  provider_id         text       NOT NULL,
  method              text       NOT NULL,
  connection_mode     text       NOT NULL,
  methodology_version smallint   NOT NULL,
  window_start        timestamptz NOT NULL,
  bins                jsonb      NOT NULL,
  n                   integer    NOT NULL,
  min_ms              integer,
  PRIMARY KEY (geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
);

-- Read path: WHERE worker_provider=<scope> AND method=? AND connection_mode=?
-- AND window_start > ? (then geo/provider filtered from the small result set).
CREATE INDEX IF NOT EXISTS latency_histogram_1h_read
  ON latency_histogram_1h (worker_provider, method, connection_mode, window_start);
CREATE INDEX IF NOT EXISTS latency_histogram_1d_read
  ON latency_histogram_1d (worker_provider, method, connection_mode, window_start);
