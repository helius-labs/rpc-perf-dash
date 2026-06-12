-- 0005_run_id.sql
--
-- The on-demand benchmark CLI now tags every challenge it produces with a
-- run-level UUID so the dashboard can list past benchmark runs (/runs) and
-- show per-run summaries (/run/[id]).
--
-- Existing challenge rows (continuous mode) have run_id = NULL and don't
-- appear in the /runs list.

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS run_id uuid;

CREATE INDEX IF NOT EXISTS challenges_run_id_idx
  ON challenges (run_id, generated_at DESC) WHERE run_id IS NOT NULL;
