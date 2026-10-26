-- 0003_status_timeline_hourly.sql — hourly pipeline counts for the /status
-- "Throughput · 24h" timeline.
--
-- The timeline used to count `challenges` (~210k rows/24h) and
-- `challenge_assignments` (~640k rows/24h) by time range on every cache miss.
-- Both tables are update-heavy, so those index scans hit the heap, and cold they
-- ran past the web read lanes (15s, then 40s) and the section rendered
-- "temporarily unavailable". The generator now keeps this table current on its
-- own interval (apps/generator/src/statusTimeline.ts) and the web reads ~24 rows
-- by primary key.
--
-- One row per hour (hour_start = date_trunc('hour', ...)). The counts cover
-- [hour_start, counted_to). Each generator tick adds the rows in
-- [counted_to, now() - lag) and advances counted_to. Once the hour has been closed
-- for the settle margin, one full recount replaces the counts; a row with
-- computed_at >= hour_start + 1h + settle is final. Rows older than 8 days are
-- pruned by the same job.
--
-- A new, empty table: takes no lock on any live table. Idempotent (IF NOT EXISTS),
-- matching the 0001/0002 convention.

CREATE TABLE IF NOT EXISTS status_timeline_hourly (
  hour_start   timestamptz PRIMARY KEY,
  dispatched   integer NOT NULL,
  claimed      integer NOT NULL,
  sampled      integer NOT NULL,
  counted_to   timestamptz NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);
