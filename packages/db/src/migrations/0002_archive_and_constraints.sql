-- 0002_archive_and_constraints.sql
--
-- (1) Pin the exclusion_reason enum at the DB level. TypeScript enforces it on
--     the write path; this guards against future callers (rollup-cron, web,
--     ad-hoc SQL) inserting a freeform string.
--
-- (2) Add the samples_archived partitioned table family. Archive-rule rows
--     (1% deterministic + flagged + honeypots) get COPIED here just before
--     their source partition in `samples` is dropped at day-30, so the 90-day
--     raw-retention claim in methodology.md actually holds.
--
-- (3) Pin the correctness enum + status enum + connection_mode enum + egress
--     enum the same way. Cheap, prevents drift.

ALTER TABLE samples
  ADD CONSTRAINT samples_correctness_chk CHECK (
    correctness IN ('correct', 'incorrect', 'incomplete', 'stale', 'ambiguous')
  ),
  ADD CONSTRAINT samples_status_chk CHECK (
    status IN ('ok', 'error', 'timeout')
  ),
  ADD CONSTRAINT samples_mode_chk CHECK (
    connection_mode IN ('cold', 'warm')
  ),
  ADD CONSTRAINT samples_egress_chk CHECK (
    egress_path IN ('aws-nat-a', 'aws-nat-b', 'hetzner-wg')
  ),
  ADD CONSTRAINT samples_exclusion_chk CHECK (
    exclusion_reason IS NULL
    OR exclusion_reason IN (
      'tier_archive_unavailable',
      'tier_rate_limited',
      'quorum_ambiguous',
      'freshness_stale',
      'correctness_failure',
      'reliability_failure',
      'shadow_diagnostic_only'
    )
  );

ALTER TABLE challenges
  ADD CONSTRAINT challenges_status_chk CHECK (
    status IN ('pending_quorum', 'ready', 'expired', 'ambiguous')
  );

ALTER TABLE challenge_assignments
  ADD CONSTRAINT assignments_status_chk CHECK (
    status IN ('unclaimed', 'claimed', 'done', 'expired')
  );

-- ────────────────────────────────────────────────────────────────────────
-- samples_archived: same shape as samples, longer retention (90 days),
-- partitioned daily.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS samples_archived (
  LIKE samples INCLUDING ALL EXCLUDING IDENTITY
) PARTITION BY RANGE (started_at);

-- Bootstrap two partitions: today + tomorrow. The cron extends forward and
-- prunes > 90 days.
DO $$
DECLARE
  d date := current_date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS samples_archived_%s PARTITION OF samples_archived FOR VALUES FROM (%L) TO (%L)',
    to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS samples_archived_%s PARTITION OF samples_archived FOR VALUES FROM (%L) TO (%L)',
    to_char(d + 1, 'YYYYMMDD'), (d + 1)::timestamptz, (d + 2)::timestamptz
  );
END $$;
