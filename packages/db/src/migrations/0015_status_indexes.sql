-- Status-page read-path index.
--
-- Live-DB note: infra/scripts/build-status-indexes.ts builds this same index
-- with CREATE INDEX CONCURRENTLY (no write lock) and records this migration
-- as applied — use it instead of this file on a database under load.
--
-- The /status pipeline funnel (apps/web/src/lib/status.ts) and the 24h timeline
-- both probe `challenge_assignments` by `claimed_at`:
--   count(*)      WHERE claimed_at > now() - interval '5 min'
--   max(claimed_at) WHERE claimed_at > now() - interval '15 min'
-- plus per-15-min buckets over 24h. `challenge_assignments` is NOT partitioned
-- and had NO index on `claimed_at` (its only index, assignments_claim_idx, leads
-- with worker_provider for the worker claim path), so every /status render — the
-- page is deliberately uncached and AutoRefresh re-renders it every 20s — fell
-- back to a full-table seq scan. This index turns those into range scans.
--
-- NOTE: on the live production DB this is built with CREATE INDEX CONCURRENTLY
-- (challenge_assignments is written continuously by the generator, so a plain
-- CREATE INDEX would lock the insert path) — see
-- infra/scripts/build-status-indexes.ts. This migration's plain
-- CREATE INDEX IF NOT EXISTS is the canonical definition for fresh databases and
-- is a no-op where the concurrent build already created it.

CREATE INDEX IF NOT EXISTS assignments_claimed_at_idx
  ON challenge_assignments (claimed_at);
