-- 0007_worker_provider.sql
--
-- Multi-vantage worker support (plan workstream B). Adds the worker_provider
-- dimension to every table that today identifies a sample's origin by (region,
-- egress_path), and rewires challenge_assignments' PK + filters so the same
-- (challenge_id, region, egress_path) can exist across different clouds without
-- colliding.
--
-- Also drops the static samples_egress_chk and challenge_assignments shadow-
-- lottery infrastructure — the new vantage registry is heartbeat-driven, which
-- is fundamentally incompatible with a static allowlist of egress paths.

-- ────────────────────────────────────────────────────────────────────────
-- (1) worker_provider columns. Backfill existing rows with 'aws' so the
--     NOT NULL constraint applies cleanly.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE samples
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

ALTER TABLE challenge_assignments
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

ALTER TABLE worker_heartbeat
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

ALTER TABLE rollups_5m
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

ALTER TABLE rollups_1h
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

ALTER TABLE rollups_1d
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

ALTER TABLE samples_archived
  ADD COLUMN IF NOT EXISTS worker_provider text NOT NULL DEFAULT 'aws';

-- ────────────────────────────────────────────────────────────────────────
-- (2) Drop samples_egress_chk. The heartbeat-driven vantage registry is the
--     new source of truth for valid egress_path values; a static allowlist
--     would force a migration on every new vantage.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE samples DROP CONSTRAINT IF EXISTS samples_egress_chk;

-- No CHECK constraint on worker_provider — same rationale.

-- ────────────────────────────────────────────────────────────────────────
-- (3) challenge_assignments PK and index gain worker_provider so the same
--     (challenge_id, region, egress_path) can exist for multiple clouds.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE challenge_assignments
  DROP CONSTRAINT IF EXISTS challenge_assignments_pkey;

ALTER TABLE challenge_assignments
  ADD PRIMARY KEY (challenge_id, worker_provider, region, egress_path);

DROP INDEX IF EXISTS assignments_claim_idx;
CREATE INDEX IF NOT EXISTS assignments_claim_idx
  ON challenge_assignments (worker_provider, region, egress_path, status);

-- ────────────────────────────────────────────────────────────────────────
-- (4) samples_lookup_idx gains worker_provider for cross-cloud drill-down
--     and for the per-(provider, geo_region) aggregation the leaderboard
--     now runs (one query per GeoRegion).
-- ────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS samples_lookup_idx;
CREATE INDEX IF NOT EXISTS samples_lookup_idx
  ON samples (provider_id, method, worker_provider, region, connection_mode, started_at);
