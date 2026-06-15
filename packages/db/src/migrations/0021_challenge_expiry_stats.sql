-- Make expireStaleChallenges use its partial index instead of a seq scan.
--
-- After 0020, the candidate predicate `status='ready' AND has_samples=false` is
-- rare (~tens of rows), but the planner assumes `status` and `has_samples` are
-- independent and estimates ~300k matches → it seq-scans all of `challenges`
-- (~12s every run) instead of the 9-row partial index
-- challenges_expiry_candidates_idx. The combination is correlated (almost all
-- has_samples=false rows are status='expired', not 'ready'), so MCV extended
-- statistics give the planner the real combo frequencies and it uses the index.
--
-- (DROP first to also remove the dependencies/ndistinct stat object created
-- during diagnosis — MCV is the kind that fixes this case.)

DROP STATISTICS IF EXISTS challenges_status_has_samples;
CREATE STATISTICS challenges_status_has_samples (mcv) ON status, has_samples FROM challenges;
ANALYZE challenges;
