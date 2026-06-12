-- 0017_archive_drop_volatile_checks.sql
--
-- samples_archived must NOT carry its own copies of the volatile enum/allowlist
-- CHECK constraints. They were copied wholesale from `samples` by
-- `CREATE TABLE samples_archived (LIKE samples INCLUDING ALL ...)` in 0002 and
-- then frozen, because every later constraint migration only ever touched
-- `samples`:
--   * 0004 extended, then 0007 DROPPED samples_egress_chk on samples (the
--     static egress allowlist is incompatible with the heartbeat-driven
--     multi-cloud vantage registry) — samples_archived kept the frozen 0002
--     allowlist IN ('aws-nat-a','aws-nat-b','hetzner-wg').
--   * 0014 relaxed samples_exclusion_chk on samples to the v=2 vocabulary —
--     samples_archived kept the v=1-only version.
--
-- Result: the daily archival cron (apps/generator/src/partitions.ts), which
-- copies aging samples_YYYYMMDD partitions into samples_archived, was rejected
-- by these stale constraints (multi-cloud egress paths, v=2 exclusion reasons).
-- Because ensurePartitions() ran awaited at generator startup, that fatal
-- error crashlooped the generator for ~28h on 2026-06-07 and starved the whole
-- fleet. (The generator is now hardened to treat archival failures as non-fatal
-- warnings, but the rows still need to actually land in the archive.)
--
-- Fix the class, not the instance: samples_archived is an append-only audit
-- copy. Every row in it already passed `samples`' constraints at write time, so
-- re-validating the archived copy against an independently-maintained ruleset
-- is pure liability — it can only ever drift and reject legitimate history.
-- Drop the volatile CHECKs here; `samples` remains the gatekeeper. Structural
-- constraints (NOT NULL, types, partition bounds) are unaffected.
--
-- Idempotent: IF EXISTS on every drop. After this lands, the next partition
-- cron tick archives the backlog (samples_20260508 onward) cleanly.

BEGIN;

ALTER TABLE samples_archived DROP CONSTRAINT IF EXISTS samples_egress_chk;
ALTER TABLE samples_archived DROP CONSTRAINT IF EXISTS samples_exclusion_chk;
ALTER TABLE samples_archived DROP CONSTRAINT IF EXISTS samples_correctness_chk;
ALTER TABLE samples_archived DROP CONSTRAINT IF EXISTS samples_status_chk;
ALTER TABLE samples_archived DROP CONSTRAINT IF EXISTS samples_mode_chk;

COMMIT;
