-- 0008_rollups_worker_provider_pk.sql
--
-- Migration 0007 added the worker_provider column to rollups_5m / rollups_1h /
-- rollups_1d with DEFAULT 'aws'. It did NOT add worker_provider to the PK,
-- which means a future deployment that happens to share a region string
-- across clouds would silently collide rollup rows. It also means the rollup
-- writer can't emit per-(worker_provider, region) aggregates — it would just
-- overwrite the existing 'aws' row.
--
-- Fix:
--   1. Extend the PK to include worker_provider.
--   2. Truncate rollups so the writer repopulates them with correct
--      per-(worker_provider, region) breakdown on the next tick. (Rollups
--      regenerate from samples every 5 min, so this is a 5-min hole, not
--      a data loss.)

TRUNCATE TABLE rollups_5m;
TRUNCATE TABLE rollups_1h;
TRUNCATE TABLE rollups_1d;

ALTER TABLE rollups_5m DROP CONSTRAINT IF EXISTS rollups_5m_pkey;
ALTER TABLE rollups_5m ADD PRIMARY KEY (
  provider_id, method, worker_provider, region, bucket, connection_mode,
  methodology_version, window_start
);

ALTER TABLE rollups_1h DROP CONSTRAINT IF EXISTS rollups_1h_pkey;
ALTER TABLE rollups_1h ADD PRIMARY KEY (
  provider_id, method, worker_provider, region, bucket, connection_mode,
  methodology_version, window_start
);

ALTER TABLE rollups_1d DROP CONSTRAINT IF EXISTS rollups_1d_pkey;
ALTER TABLE rollups_1d ADD PRIMARY KEY (
  provider_id, method, worker_provider, region, bucket, connection_mode,
  methodology_version, window_start
);
