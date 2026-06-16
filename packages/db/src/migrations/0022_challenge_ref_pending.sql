-- Partial index that backs the reference_response trim job (the generator's
-- maintenance cron nulls challenges.reference_response once a challenge is past
-- its 6h window — the bulky getBlock/getTransaction JSON dominated storage).
--
-- The recurring trim query is:
--   UPDATE challenges SET reference_response = NULL
--    WHERE ctid IN (SELECT ctid FROM challenges
--                    WHERE reference_response IS NOT NULL
--                      AND generated_at < now() - interval '6 hours' LIMIT n)
-- Without this index that inner SELECT walks the whole generated_at<6h slice
-- (millions of rows) with a heap fetch per row to test reference_response every
-- 5 min — exactly the every-tick seq-scan failure class 0020/0021 just hit on
-- this table. The partial index is physically tiny: it only covers rows that
-- still hold a payload (≈ last 6h ≈ ~27k rows steady-state); a row drops out of
-- the index the moment it's nulled.
--
-- Plain CREATE INDEX (brief SHARE lock, ~seconds on ~1.7M rows) per the repo's
-- migration convention — same as 0020's challenges_expiry_candidates_idx. For a
-- zero-lock build, mirror infra/scripts/build-*.ts (CREATE INDEX CONCURRENTLY).
--
-- ANALYZE so the planner has fresh stats for the new index immediately. The
-- predicate is single-column (reference_response IS NOT NULL), so its
-- selectivity comes from the column's null_frac — plain ANALYZE is the right
-- fix (no multi-column CREATE STATISTICS needed, unlike 0021).

CREATE INDEX IF NOT EXISTS challenges_ref_pending_idx
  ON challenges (generated_at)
  WHERE reference_response IS NOT NULL;

ANALYZE challenges;

-- Backs the control-table prune's eligibility step. eligibility accumulates a
-- fresh row-set per heavy-rollup tick (~288/day) keyed on window_end and is
-- otherwise unindexed on it; without this the prune's `window_end < now()-31d`
-- inner SELECT parallel-seq-scans the whole (multi-million-row) table every 5
-- min — including the steady-state case where there is nothing to delete.
-- window_end is monotonic (always now() at insert), so inserts append to the
-- right edge of this btree (cheap).
CREATE INDEX IF NOT EXISTS eligibility_window_end_idx
  ON eligibility (window_end);
