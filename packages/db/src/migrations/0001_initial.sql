-- 0001_initial.sql — owned by hand because Drizzle does not yet support
-- native partitioning, the `tdigest` extension, or pg_partman setup.
--
-- Apply via `pnpm db:migrate` (which runs migrate.ts).

-- ────────────────────────────────────────────────────────────────────────
-- Extensions
-- ────────────────────────────────────────────────────────────────────────
-- No extensions are used. Quantile composition relies on scalar percentile
-- columns + native percentile_cont (managed Postgres providers commonly
-- disallow custom extensions like tdigest) — see methodology.md
-- "Quantile composition" section.

-- ────────────────────────────────────────────────────────────────────────
-- Control plane
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS challenges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method               text NOT NULL,
  params               jsonb NOT NULL,
  bucket               text NOT NULL,
  commitment_hash      bytea NOT NULL,
  seed_revealed_at     timestamptz,
  seed                 bytea,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  reference_response   jsonb,
  reference_hash       bytea,
  reference_tip_slot   bigint,
  methodology_version  smallint NOT NULL,
  status               text NOT NULL,
  is_honeypot          boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS challenges_status_idx ON challenges (status, generated_at);
CREATE INDEX IF NOT EXISTS challenges_method_idx ON challenges (method, generated_at);

-- View that hides is_honeypot from workers. Workers MUST query this view, not
-- the base table, so honeypots are indistinguishable from regular challenges
-- at execution time.
CREATE OR REPLACE VIEW challenges_worker_view AS
SELECT
  id, method, params, bucket, commitment_hash,
  generated_at, expires_at, methodology_version, status
FROM challenges;

CREATE TABLE IF NOT EXISTS challenge_assignments (
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  region        text NOT NULL,
  egress_path   text NOT NULL,
  claimed_at    timestamptz,
  completed_at  timestamptz,
  status        text NOT NULL DEFAULT 'unclaimed',
  worker_id     text,
  PRIMARY KEY (challenge_id, region, egress_path)
);
CREATE INDEX IF NOT EXISTS assignments_claim_idx
  ON challenge_assignments (region, egress_path, status);

CREATE TABLE IF NOT EXISTS providers (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  benchmarked      boolean NOT NULL,
  quorum_eligible  boolean NOT NULL,
  utility          boolean NOT NULL,
  tier_name        text NOT NULL,
  retention_slots  text NOT NULL,
  monthly_cap      bigint,
  config           jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS eligibility (
  provider_id            text NOT NULL REFERENCES providers(id),
  region                 text NOT NULL,
  method                 text NOT NULL,
  methodology_version    smallint NOT NULL,
  window_end             timestamptz NOT NULL,
  eligible               boolean NOT NULL,
  failing_reason         text,
  n_valid                integer NOT NULL,
  reliability            real NOT NULL,
  correctness            real NOT NULL,
  honeypot_pass_rate_lb  real NOT NULL,
  PRIMARY KEY (provider_id, region, method, methodology_version, window_end)
);

CREATE TABLE IF NOT EXISTS quorum_log (
  challenge_id     uuid PRIMARY KEY REFERENCES challenges(id) ON DELETE CASCADE,
  active_nodes     jsonb NOT NULL,
  decision         text NOT NULL,
  decision_reason  text,
  dissenters       jsonb,
  decided_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS methodology_versions (
  version         smallint PRIMARY KEY,
  effective_from  timestamptz NOT NULL,
  changelog       text NOT NULL
);

CREATE TABLE IF NOT EXISTS generator_heartbeat (
  id        integer PRIMARY KEY DEFAULT 1,
  pid       integer NOT NULL,
  hostname  text NOT NULL,
  beat_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeat (
  worker_id    text PRIMARY KEY,
  region       text NOT NULL,
  egress_path  text NOT NULL,
  pid          integer NOT NULL,
  beat_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS honeypot_pool (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method                   text NOT NULL,
  params                   jsonb NOT NULL,
  expected_projection_hash bytea NOT NULL,
  expected_projection      jsonb NOT NULL,
  methodology_version      smallint NOT NULL,
  last_used_at             timestamptz,
  use_count                integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS honeypot_lru_idx
  ON honeypot_pool (method, last_used_at NULLS FIRST);

-- ────────────────────────────────────────────────────────────────────────
-- Hot path — samples (partitioned daily by started_at)
--
-- Daily partitions are managed by pg_partman or a scheduled cron in the
-- generator service. M1 ships the partitioned parent + a today/tomorrow
-- partition pair so the worker can write immediately.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS samples (
  challenge_id         uuid NOT NULL,
  method               text NOT NULL,
  provider_id          text NOT NULL,
  plan_tier            text,
  region               text NOT NULL,
  worker_id            text NOT NULL,
  egress_path          text NOT NULL,
  endpoint_used        text NOT NULL,
  bucket               text NOT NULL,
  connection_mode      text NOT NULL,
  started_at           timestamptz NOT NULL,
  latency_ms           integer NOT NULL,
  status               text NOT NULL,
  error_code           text,
  http_status          smallint,
  response_hash        bytea NOT NULL,
  provider_tip_slot    bigint,
  reference_tip_slot   bigint,
  response_slot        bigint,
  freshness_lag        bigint,
  correctness          text NOT NULL,
  exclusion_reason     text,
  methodology_version  smallint NOT NULL,
  is_honeypot          boolean NOT NULL DEFAULT false,
  ranking_eligible     boolean NOT NULL DEFAULT true,
  raw_response         jsonb
) PARTITION BY RANGE (started_at);

CREATE INDEX IF NOT EXISTS samples_lookup_idx
  ON samples (provider_id, method, region, connection_mode, started_at);
CREATE INDEX IF NOT EXISTS samples_challenge_idx ON samples (challenge_id);
CREATE INDEX IF NOT EXISTS samples_honeypot_idx ON samples (started_at) WHERE is_honeypot;

-- Bootstrap partitions: today + tomorrow. The generator's daily partition cron
-- (or pg_partman) extends the window forward and drops > 30-day partitions.
DO $$
DECLARE
  d date := current_date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS samples_%s PARTITION OF samples FOR VALUES FROM (%L) TO (%L)',
    to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS samples_%s PARTITION OF samples FOR VALUES FROM (%L) TO (%L)',
    to_char(d + 1, 'YYYYMMDD'), (d + 1)::timestamptz, (d + 2)::timestamptz
  );
END $$;

-- ────────────────────────────────────────────────────────────────────────
-- Rollups — populated by 5-minute cron (rollup-worker)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rollups_5m (
  provider_id            text NOT NULL,
  method                 text NOT NULL,
  region                 text NOT NULL,
  bucket                 text NOT NULL,
  connection_mode        text NOT NULL,
  methodology_version    smallint NOT NULL,
  window_start           timestamptz NOT NULL,
  sample_count_total     integer NOT NULL,
  sample_count_valid     integer NOT NULL,
  sample_count_excluded  integer NOT NULL,
  exclusion_breakdown    jsonb,
  latency_p50            integer,
  latency_p95            integer,
  latency_p99            integer,
  latency_stddev         double precision,
  success_rate           real,
  correctness_rate       real,
  completeness_rate      real,
  freshness_avg_lag      real,
  freshness_p95_lag      integer,
  honeypot_pass_count    integer,
  honeypot_total         integer,
  PRIMARY KEY (provider_id, method, region, bucket, connection_mode, methodology_version, window_start)
);

CREATE TABLE IF NOT EXISTS rollups_1h (LIKE rollups_5m INCLUDING ALL);
CREATE TABLE IF NOT EXISTS rollups_1d (LIKE rollups_5m INCLUDING ALL);
