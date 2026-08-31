-- ════════════════════════════════════════════════════════════════════════
-- 0004 — drop two vestigial `samples` indexes
-- ════════════════════════════════════════════════════════════════════════
--
-- Both date from when the dashboard read RAW SAMPLES. It now reads `rollups`,
-- so both indexes became dead weight without anything noticing — they cost
-- ~890 MB/day of space AND of index maintenance on every sample INSERT.
--
-- Measured on 2026-08-31, per daily partition (7-day lifetime each):
--
--   index                                        size     idx_scan
--   samples_lookup_idx    (provider-leading)     726 MB   11
--   samples_dash_idx      (connection_mode-...)  164 MB    4
--   samples_challenge_idx (challenge_id)          56 MB   590,858
--   samples_started_at_idx1 (started_at)          49 MB    78,287
--
-- i.e. the two largest indexes served 15 scans between them across a whole
-- partition lifetime, while the two smallest served 670k.
--
-- Why they are safe to drop — every live consumer was traced:
--   * rollup.ts base CTEs filter `started_at` only (`WHERE s.started_at >= ...`)
--     and GROUP BY provider_id afterwards. That is a time-range scan, never a
--     provider_id-leading probe, so samples_lookup_idx cannot serve it.
--   * health.ts's per-provider aggregate (`started_at > now() - 15 min AND
--     provider_id IN (...)`) plans as an Index Scan on samples_<day>_started_at_idx1
--     — confirmed with EXPLAIN against prod.
--   * /raw and /challenges look up by challenge_id (samples_challenge_idx).
--   * /status and fleet health filter bare started_at (samples_started_at_idx1).
--   * samples_dash_idx's own comment in 0001_initial.sql claims it is "the
--     dashboard read path" — that stopped being true when the dashboard moved to
--     rollups, which is why it sees 4 scans per partition lifetime.
--
-- Neither is unique and neither backs a constraint or an ON CONFLICT target
-- (`samples` has no primary key), so dropping them cannot affect writes beyond
-- making them cheaper.
--
-- These are PARTITIONED indexes on the `samples` parent, so the DROP cascades to
-- every child and future partitions simply never get them. A DROP takes
-- ACCESS EXCLUSIVE on the parent and each partition; it is fast (an unlink, not a
-- rewrite), but run it under a short lock_timeout so a busy parent makes it give
-- up rather than queue the lock and convoy every insert behind it.

SET lock_timeout = '5s';

DROP INDEX IF EXISTS samples_lookup_idx;
DROP INDEX IF EXISTS samples_dash_idx;

RESET lock_timeout;
