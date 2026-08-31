-- ════════════════════════════════════════════════════════════════════════
-- 0003 — drop dead storage: samples_archived + two vestigial samples indexes
-- ════════════════════════════════════════════════════════════════════════
--
-- 0001_initial.sql no longer CREATES any of these, so a fresh bootstrap never
-- makes them and every statement here is a harmless no-op. This migration exists
-- only for databases that already applied the earlier 0001 (migrate.ts tracks by
-- filename, so an existing DB skips 0001 forever and would otherwise keep these
-- objects indefinitely).
--
-- WHY. On 2026-08-31 the database reached 2183 GB. Retention was NOT the bug —
-- every window was working exactly as coded, and the oldest archive partition
-- was always precisely current_date - 30. Every bound was on TIME and ROW COUNT;
-- nothing bounded BYTES PER ROW. 2149 of the 2183 GB was raw_response TOAST, and
-- 99.4% of that was getBlock at ~1.84 MB stored per row.
--
-- 1) samples_archived — 1837 GB (84% of the database) with ZERO readers: no
--    SELECT against it existed anywhere in apps/ or packages/. It also carried a
--    2x amplification of its own, because the archival
--    INSERT ... SELECT ... ON CONFLICT DO NOTHING was idempotent in ROWS but not
--    in BYTES: a re-run re-TOASTs each ~1.8 MB body before discovering the row
--    already exists, and those chunks die immediately. pg_stat showed exactly
--    2.00 inserts per live TOAST chunk and ~51% page utilization on every archive
--    partition, against 1.02 and ~98% for the same rows in `samples`.
--
-- 2) samples_lookup_idx / samples_dash_idx — ~890 MB/day of space AND of index
--    maintenance on every sample INSERT, for 11 and 4 index scans across a
--    partition's entire 7-day lifetime (challenge_id and started_at served
--    590,858 and 78,287 over the same period). Both date from when the dashboard
--    read raw samples; it reads `rollups` now. Every live consumer was traced
--    before removal: the rollup base CTEs filter started_at only and GROUP BY
--    provider_id afterwards (a time-range scan, never a provider-leading probe),
--    and health.ts's per-provider aggregate plans as an Index Scan on
--    samples_<day>_started_at_idx1 — confirmed with EXPLAIN against prod. Neither
--    index is unique and neither backs a constraint or ON CONFLICT target
--    (`samples` has no primary key), so dropping them only makes writes cheaper.
--
-- Paired code changes that must ship BEFORE this migration:
--   * apps/generator/src/partitions.ts — archive create/copy/prune path removed.
--     LOAD-BEARING: the old code did 'samples_archived'::regclass OUTSIDE its
--     EXCEPTION handler, and ensurePartitions is awaited at startup in index.ts,
--     so applying this to a fleet still running old code crashloops everything.
--     Deploy generator + workers FIRST — this inverts the usual
--     migrations-then-code order in CLAUDE.md.
--   * packages/runner/src/record.ts — keepRaw no longer retains raw for honeypot
--     rows that PASSED (~34 GB/day -> ~115 MB/day), and RAW_RESPONSE_MAX_CHARS
--     caps every retained body at 32 KiB.
--
-- Reclaim from the DROPs is physical and immediate; no VACUUM or pg_repack
-- needed. Neon's BILLED storage still lags by the history/PITR window.
--
-- Irreversible: archived rows are gone. The 7-day `samples` window is the
-- forensic surface, and /raw reads from `samples`.

-- Partition/index DDL takes ACCESS EXCLUSIVE on the parent. A short lock_timeout
-- makes a busy table abort this statement instead of QUEUEING that lock request,
-- which would block every subsequent insert behind it (the convoy that has
-- frozen this fleet before).
SET lock_timeout = '5s';

DROP TABLE IF EXISTS samples_archived;

DROP INDEX IF EXISTS samples_lookup_idx;
DROP INDEX IF EXISTS samples_dash_idx;

RESET lock_timeout;
