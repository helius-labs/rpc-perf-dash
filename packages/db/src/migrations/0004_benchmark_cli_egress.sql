-- 0004_benchmark_cli_egress.sql
--
-- The on-demand benchmark CLI (apps/generator/src/benchmark.ts) tags its
-- samples with worker_id = 'benchmark-cli' and egress_path = 'benchmark-cli'
-- so they're distinguishable from continuous-worker samples in the DB.
--
-- The 0002_archive_and_constraints.sql migration locked egress_path to
--   ('aws-nat-a', 'aws-nat-b', 'hetzner-wg')
-- so we extend that constraint here.

ALTER TABLE samples DROP CONSTRAINT IF EXISTS samples_egress_chk;
ALTER TABLE samples ADD CONSTRAINT samples_egress_chk CHECK (
  egress_path IN ('aws-nat-a', 'aws-nat-b', 'hetzner-wg', 'benchmark-cli')
);
