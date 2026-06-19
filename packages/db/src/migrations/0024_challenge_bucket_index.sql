-- 0024_challenge_bucket_index.sql — bucket-leading index for the /challenges
-- browser's bucket filter (row query + count(*)).
--
-- Live-DB note: infra/scripts/build-challenge-bucket-index.ts builds this same
-- index with CREATE INDEX CONCURRENTLY (no write lock) and records this migration
-- as applied — use it instead of this file on a database under load.
--
-- The challenges browser (apps/web/src/lib/challengeRows.ts whereFor) filters on
-- `bucket` with ORDER BY generated_at DESC, but no index leads with bucket —
-- challenges_status_idx / challenges_method_idx lead with status / method, and
-- challenges_generated_at_idx leads with time. So a bucket filter scans the whole
-- generated_at window and filters bucket inline, for both the row slice and the
-- fetchChallengeCount count(*).
--
-- The bucket condition has two arms (challengeRows.ts):
--   exact:  bucket = 'archival__low'
--   family: bucket = 'archival' OR bucket LIKE 'archival__%'
-- text_pattern_ops makes BOTH arms index-usable: it supports equality and, unlike
-- the default collation's btree, lets the LIKE 'prefix%' arm range-scan. The
-- trailing generated_at DESC keeps the ORDER BY served from the index for a
-- selective bucket.
--
-- NOTE: on the live production DB this is built with CREATE INDEX CONCURRENTLY
-- (challenges is not partitioned — see infra/scripts/build-challenge-bucket-index.ts)
-- to avoid locking the generator's insert path. This migration's plain
-- CREATE INDEX IF NOT EXISTS is the canonical definition for fresh databases and
-- is a no-op where the concurrent build already created it.

CREATE INDEX IF NOT EXISTS challenges_bucket_idx
  ON challenges (bucket text_pattern_ops, generated_at DESC);
