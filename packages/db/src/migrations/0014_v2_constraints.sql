-- 0014_v2_constraints.sql
--
-- 0002_archive_and_constraints.sql defined CHECK constraints with v=1
-- enum values hard-coded. v=2 added new values (no_consensus,
-- consensus_disputed, auditor_unavailable, tier_method_unsupported) and
-- removed quorum-era challenge statuses. Workers writing v=2 samples were
-- rejected with samples_exclusion_chk. This migration relaxes both check
-- constraints to accept the v=2 vocabulary while keeping v=1 values for
-- pre-cutover history.

BEGIN;

ALTER TABLE samples DROP CONSTRAINT IF EXISTS samples_exclusion_chk;
ALTER TABLE samples
  ADD CONSTRAINT samples_exclusion_chk CHECK (
    exclusion_reason IS NULL
    OR exclusion_reason IN (
      -- v=1 (kept for pre-cutover sample rows)
      'tier_archive_unavailable',
      'tier_rate_limited',
      'quorum_ambiguous',
      'freshness_stale',
      'correctness_failure',
      'reliability_failure',
      'shadow_diagnostic_only',
      -- v=2 additions (see packages/shared/src/types.ts)
      'no_consensus',
      'consensus_disputed',
      'auditor_unavailable',
      'tier_method_unsupported'
    )
  );

ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_status_chk;
ALTER TABLE challenges
  ADD CONSTRAINT challenges_status_chk CHECK (
    -- v=2 only writes 'ready' and 'expired'; the others are preserved so
    -- v=1 rows still satisfy the constraint.
    status IN ('pending_quorum', 'ready', 'expired', 'ambiguous')
  );

COMMIT;
