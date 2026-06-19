/**
 * Drizzle schema. Hot-path tables (samples, rollups) are also expressed as raw
 * SQL in `migrations/0001_initial.sql` because Drizzle does not yet support
 * native partitioning, the `tdigest` column type, or `pg_partman` directly.
 *
 * The Drizzle definitions below are kept in sync for typechecking + query DSL
 * but the partition + extension setup is owned by the SQL migration.
 */

import {
  pgTable,
  text,
  uuid,
  smallint,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  index,
  doublePrecision,
  real,
  customType,
} from "drizzle-orm/pg-core";

/** bytea column type — Drizzle does not export one natively. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// (tdigest type removed — Neon's allowed-extensions list excludes it. Rollups
// store scalar p50/p95/p99 instead, computed in-cron via percentile_cont.
// See migration 0003 and methodology.md "Quantile composition".)

// ────────────────────────────────────────────────────────────────────────────
// Control plane
// ────────────────────────────────────────────────────────────────────────────

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    method: text("method").notNull(),
    params: jsonb("params").notNull(),
    bucket: text("bucket").notNull(),
    commitment_hash: bytea("commitment_hash").notNull(),
    seed_revealed_at: timestamp("seed_revealed_at", { withTimezone: true }),
    seed: bytea("seed"),
    generated_at: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    reference_response: jsonb("reference_response"),
    reference_hash: bytea("reference_hash"),
    reference_tip_slot: bigint("reference_tip_slot", { mode: "bigint" }),
    methodology_version: smallint("methodology_version").notNull(),
    status: text("status").notNull(),
    is_honeypot: boolean("is_honeypot").notNull().default(false),
    run_id: uuid("run_id"),
    // Denormalized: set true when the first sample for this challenge is written
    // (see insertSamples). Lets the stale-expiry job skip sampled challenges with
    // a cheap flag check instead of a NOT EXISTS scan over the ~40M-row samples
    // table. Migration 0020. Partial index for the expiry candidate lookup is in
    // that migration (challenges(expires_at) WHERE status='ready' AND NOT has_samples).
    has_samples: boolean("has_samples").notNull().default(false),
  },
  (t) => ({
    by_status: index("challenges_status_idx").on(t.status, t.generated_at),
    by_method: index("challenges_method_idx").on(t.method, t.generated_at),
    // recent-challenges / browser / runs filter generated_at alone with
    // ORDER BY generated_at DESC — the (status|method, generated_at) indexes
    // above lead with a non-time column. See migration 0016.
    by_generated_at: index("challenges_generated_at_idx").on(t.generated_at.desc()),
    // /challenges browser bucket filter (row query + count). text_pattern_ops so
    // both the exact (=) and family (LIKE 'prefix%') arms are index-usable. See
    // migration 0024.
    by_bucket: index("challenges_bucket_idx").on(
      t.bucket.op("text_pattern_ops"),
      t.generated_at.desc(),
    ),
  }),
);

export const challenge_assignments = pgTable(
  "challenge_assignments",
  {
    challenge_id: uuid("challenge_id").notNull().references(() => challenges.id, { onDelete: "cascade" }),
    worker_provider: text("worker_provider").notNull().default("aws"),
    region: text("region").notNull(),
    egress_path: text("egress_path").notNull(),
    claimed_at: timestamp("claimed_at", { withTimezone: true }),
    completed_at: timestamp("completed_at", { withTimezone: true }),
    status: text("status").notNull().default("unclaimed"),
    worker_id: text("worker_id"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.challenge_id, t.worker_provider, t.region, t.egress_path] }),
    by_claim: index("assignments_claim_idx").on(t.worker_provider, t.region, t.egress_path, t.status),
  }),
);

export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  benchmarked: boolean("benchmarked").notNull(),
  // `quorum_eligible` column was dropped in migration 0013 (consensus model
  // replaced the rotating quorum). Removed from this Drizzle definition.
  utility: boolean("utility").notNull(),
  tier_name: text("tier_name").notNull(),
  retention_slots: text("retention_slots").notNull(), // either a number-as-text or "full"
  monthly_cap: bigint("monthly_cap", { mode: "number" }),
  config: jsonb("config").notNull(), // endpoints, data_centers, pricing, anti_gaming_flags
});

export const eligibility = pgTable(
  "eligibility",
  {
    provider_id: text("provider_id").notNull().references(() => providers.id),
    region: text("region").notNull(),
    method: text("method").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    window_end: timestamp("window_end", { withTimezone: true }).notNull(),
    eligible: boolean("eligible").notNull(),
    failing_reason: text("failing_reason"),
    n_valid: integer("n_valid").notNull(),
    reliability: real("reliability").notNull(),
    correctness: real("correctness").notNull(),
    honeypot_pass_rate_lb: real("honeypot_pass_rate_lb").notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.provider_id, t.region, t.method, t.methodology_version, t.window_end],
    }),
  }),
);

/**
 * Per-challenge × vantage × mode consensus log. One row written per
 * `(challenge_id, worker_provider, region, egress_path, connection_mode)`
 * group, but only for *interesting* groups (disputed by the auditor, or
 * sampled into the archive, or honeypot) — see `record.ts:shouldArchive`. Full
 * per-vantage-per-mode logging would explode the row count.
 *
 * Consensus decisions are logged here. The legacy `quorum_log` table is
 * preserved for historical audit reads; new rows are written here.
 */
export const consensus_log = pgTable(
  "consensus_log",
  {
    challenge_id: uuid("challenge_id").notNull().references(() => challenges.id, { onDelete: "cascade" }),
    worker_provider: text("worker_provider").notNull(),
    region: text("region").notNull(),
    egress_path: text("egress_path").notNull(),
    connection_mode: text("connection_mode").notNull(),
    /** Per-voter projection_hashes + which voters were in the majority. */
    voters: jsonb("voters").notNull(),
    /** "consensus" | "ambiguous" | "liveness_fallback" */
    decision: text("decision").notNull(),
    decision_reason: text("decision_reason"),
    /** Provider ids that voted but disagreed with the majority. */
    dissenters: jsonb("dissenters"),
    /** "verified" | "disputed" | "auditor_unavailable" — the secondary check verdict. */
    auditor_verdict: text("auditor_verdict").notNull(),
    decided_at: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.challenge_id, t.worker_provider, t.region, t.egress_path, t.connection_mode],
    }),
    by_decided: index("consensus_log_decided_idx").on(t.decided_at),
  }),
);

/**
 * Deferred finality re-verification log. The rollup tick samples recently-
 * scored challenges whose target slot is now deeply finalized, re-fetches the
 * canonical answer from the auditor, and writes one row here per check.
 * Aggregated into the published consensus-accuracy metric.
 */
export const consensus_audit = pgTable(
  "consensus_audit",
  {
    challenge_id: uuid("challenge_id").notNull().references(() => challenges.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    audited_at: timestamp("audited_at", { withTimezone: true }).notNull().defaultNow(),
    consensus_hash: bytea("consensus_hash").notNull(),
    canonical_hash: bytea("canonical_hash"),
    matched: boolean("matched"),
    /** null when the auditor itself failed on re-fetch. */
    error: text("error"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.challenge_id] }),
    by_audited: index("consensus_audit_audited_idx").on(t.method, t.audited_at),
  }),
);

/**
 * Legacy quorum log. Read-only — preserved so /raw inspections of older
 * challenges still render. No new rows are written.
 */
export const quorum_log = pgTable(
  "quorum_log",
  {
    challenge_id: uuid("challenge_id").primaryKey().references(() => challenges.id, { onDelete: "cascade" }),
    active_nodes: jsonb("active_nodes").notNull(),
    decision: text("decision").notNull(),
    decision_reason: text("decision_reason"),
    dissenters: jsonb("dissenters"),
    decided_at: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const methodology_versions = pgTable("methodology_versions", {
  version: smallint("version").primaryKey(),
  effective_from: timestamp("effective_from", { withTimezone: true }).notNull(),
  changelog: text("changelog").notNull(),
});

export const generator_heartbeat = pgTable("generator_heartbeat", {
  id: integer("id").primaryKey().default(1),
  pid: integer("pid").notNull(),
  hostname: text("hostname").notNull(),
  beat_at: timestamp("beat_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-endpoint health snapshot for the generator's utility-RPC client.
 * Written by the generator every ~10s; consumed by the dashboard's
 * ProviderHealth "Utility RPC" row.
 *
 *   endpoint_index : ordinal position in providers.ts utility.endpoints
 *                    (0 = primary). Primary key.
 *   url_label      : short identifier — env var name and host (e.g.
 *                    "UTILITY_RPC_URL · solana-mainnet.core.chainstack.com").
 *                    No secrets.
 *   last_ok_at     : last successful RPC call.
 *   last_err_at    : last failed RPC call.
 *   last_err_msg   : human-readable error from the most recent failure.
 *   consec_fails   : consecutive failures since last_ok_at.
 *   circuit_state  : "closed" (healthy), "open" (circuit-broken, requests
 *                    skip this endpoint), or "half-open" (allowed one probe
 *                    before deciding).
 */
export const utility_rpc_status = pgTable("utility_rpc_status", {
  endpoint_index: integer("endpoint_index").primaryKey(),
  url_label: text("url_label").notNull(),
  last_ok_at: timestamp("last_ok_at", { withTimezone: true }),
  last_err_at: timestamp("last_err_at", { withTimezone: true }),
  last_err_msg: text("last_err_msg"),
  consec_fails: integer("consec_fails").notNull().default(0),
  circuit_state: text("circuit_state").notNull().default("closed"),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const worker_heartbeat = pgTable(
  "worker_heartbeat",
  {
    worker_id: text("worker_id").primaryKey(),
    worker_provider: text("worker_provider").notNull().default("aws"),
    region: text("region").notNull(),
    egress_path: text("egress_path").notNull(),
    pid: integer("pid").notNull(),
    beat_at: timestamp("beat_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const honeypot_pool = pgTable(
  "honeypot_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    method: text("method").notNull(),
    params: jsonb("params").notNull(),
    expected_projection_hash: bytea("expected_projection_hash").notNull(),
    expected_projection: jsonb("expected_projection").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    use_count: integer("use_count").notNull().default(0),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    by_lru: index("honeypot_lru_idx").on(t.method, t.last_used_at),
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Hot path — samples (partitioned) + rollups (with tdigest)
//
// These tables are owned by `migrations/0001_initial.sql`. The Drizzle
// definitions below mirror that for query DSL + typechecking only.
// ────────────────────────────────────────────────────────────────────────────

export const samples = pgTable(
  "samples",
  {
    challenge_id: uuid("challenge_id").notNull(),
    method: text("method").notNull(),
    provider_id: text("provider_id").notNull(),
    plan_tier: text("plan_tier"),
    worker_provider: text("worker_provider").notNull().default("aws"),
    region: text("region").notNull(),
    worker_id: text("worker_id").notNull(),
    egress_path: text("egress_path").notNull(),
    endpoint_used: text("endpoint_used").notNull(),
    bucket: text("bucket").notNull(),
    connection_mode: text("connection_mode").notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull(),
    latency_ms: integer("latency_ms").notNull(),
    status: text("status").notNull(),
    error_code: text("error_code"),
    http_status: smallint("http_status"),
    response_hash: bytea("response_hash").notNull(),
    provider_tip_slot: bigint("provider_tip_slot", { mode: "bigint" }),
    reference_tip_slot: bigint("reference_tip_slot", { mode: "bigint" }),
    response_slot: bigint("response_slot", { mode: "bigint" }),
    freshness_lag: bigint("freshness_lag", { mode: "bigint" }),
    correctness: text("correctness").notNull(),
    exclusion_reason: text("exclusion_reason"),
    failure_category: text("failure_category"),
    failure_detail: text("failure_detail"),
    methodology_version: smallint("methodology_version").notNull(),
    is_honeypot: boolean("is_honeypot").notNull().default(false),
    ranking_eligible: boolean("ranking_eligible").notNull().default(true),
    raw_response: jsonb("raw_response"),
  },
  (t) => ({
    by_lookup: index("samples_lookup_idx").on(
      t.provider_id,
      t.method,
      t.worker_provider,
      t.region,
      t.connection_mode,
      t.started_at,
    ),
    by_challenge: index("samples_challenge_idx").on(t.challenge_id),
    // Dashboard read path: aggregates ACROSS providers, so it filters
    // (connection_mode, method, started_at) without provider_id — the lookup
    // index above (provider_id-leading) can't serve it. See migration 0011.
    by_dash: index("samples_dash_idx").on(t.connection_mode, t.method, t.started_at),
    // /status + fleet-health aggregates filter `started_at` alone (no
    // connection_mode/method/provider equality), which neither index above can
    // serve — bare started_at range index for those. See migration 0016.
    by_started_at: index("samples_started_at_idx").on(t.started_at),
  }),
);

// rollups_5m / rollups_1h / rollups_1d share the same shape. Drizzle requires
// inline column definitions per table, so the helper below avoids repetition.
function rollupColumns() {
  return {
    provider_id: text("provider_id").notNull(),
    method: text("method").notNull(),
    worker_provider: text("worker_provider").notNull().default("aws"),
    region: text("region").notNull(),
    bucket: text("bucket").notNull(),
    connection_mode: text("connection_mode").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    window_start: timestamp("window_start", { withTimezone: true }).notNull(),
    sample_count_total: integer("sample_count_total").notNull(),
    sample_count_valid: integer("sample_count_valid").notNull(),
    sample_count_excluded: integer("sample_count_excluded").notNull(),
    exclusion_breakdown: jsonb("exclusion_breakdown"),
    latency_p50: integer("latency_p50"),
    latency_p95: integer("latency_p95"),
    latency_p99: integer("latency_p99"),
    latency_stddev: doublePrecision("latency_stddev"),
    success_rate: real("success_rate"),
    correctness_rate: real("correctness_rate"),
    completeness_rate: real("completeness_rate"),
    freshness_avg_lag: real("freshness_avg_lag"),
    freshness_p95_lag: integer("freshness_p95_lag"),
    honeypot_pass_count: integer("honeypot_pass_count"),
    honeypot_total: integer("honeypot_total"),
  };
}

export const rollups_5m = pgTable("rollups_5m", rollupColumns(), (t) => ({
  pk: primaryKey({
    columns: [
      t.provider_id,
      t.method,
      t.region,
      t.bucket,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ],
  }),
  // Chart read path: filters (connection_mode, method, window_start) across
  // providers — the provider_id-leading PK can't serve it. See migration 0011.
  dash: index("rollups_5m_dash_idx").on(t.connection_mode, t.method, t.window_start),
}));

export const rollups_1h = pgTable("rollups_1h", rollupColumns(), (t) => ({
  pk: primaryKey({
    columns: [
      t.provider_id,
      t.method,
      t.region,
      t.bucket,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ],
  }),
  dash: index("rollups_1h_dash_idx").on(t.connection_mode, t.method, t.window_start),
}));

export const rollups_1d = pgTable("rollups_1d", rollupColumns(), (t) => ({
  pk: primaryKey({
    columns: [
      t.provider_id,
      t.method,
      t.region,
      t.bucket,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ],
  }),
  dash: index("rollups_1d_dash_idx").on(t.connection_mode, t.method, t.window_start),
}));

// ────────────────────────────────────────────────────────────────────────────
// Leaderboard precompute (long-window perf — migration 0010)
//
// region -> geo lookup, seeded by the generator from GEO_REGION_MAP so the
// precompute's SQL grouping can't drift from the FE's geoRegionOf mapping.
// ────────────────────────────────────────────────────────────────────────────
export const geo_region_map = pgTable(
  "geo_region_map",
  {
    worker_provider: text("worker_provider").notNull(),
    region: text("region").notNull(),
    geo: text("geo").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.worker_provider, t.region] }) }),
);

// leaderboard_agg_1h / _1d share the same shape (hourly feeds 7d, daily feeds
// 30d). One row per (geo, infra-or-'__all__', provider, method, mode, mv,
// time-bucket). Percentiles are correct-only, computed over the POOLED geo
// samples per bucket; counts/numerators let the read derive exact ratios.
function leaderboardAggColumns() {
  return {
    geo: text("geo").notNull(),
    worker_provider: text("worker_provider").notNull(),
    provider_id: text("provider_id").notNull(),
    method: text("method").notNull(),
    connection_mode: text("connection_mode").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    window_start: timestamp("window_start", { withTimezone: true }).notNull(),
    latency_p50_correct: integer("latency_p50_correct"),
    latency_p95_correct: integer("latency_p95_correct"),
    latency_p99_correct: integer("latency_p99_correct"),
    latency_stddev: doublePrecision("latency_stddev"),
    sample_count_valid: integer("sample_count_valid").notNull(),
    sample_count_total: integer("sample_count_total").notNull(),
    sample_count_failed: integer("sample_count_failed").notNull(),
    honeypot_pass_count: integer("honeypot_pass_count").notNull(),
    honeypot_total: integer("honeypot_total").notNull(),
    success_num: integer("success_num").notNull(),
    correctness_num: integer("correctness_num").notNull(),
    correctness_den: integer("correctness_den").notNull(),
    completeness_num: integer("completeness_num").notNull(),
    completeness_den: integer("completeness_den").notNull(),
    freshness_p95_lag: integer("freshness_p95_lag"),
    n_wins: integer("n_wins").notNull().default(0),
  };
}

export const leaderboard_agg_1h = pgTable("leaderboard_agg_1h", leaderboardAggColumns(), (t) => ({
  pk: primaryKey({
    columns: [
      t.geo,
      t.worker_provider,
      t.provider_id,
      t.method,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ],
  }),
  read: index("leaderboard_agg_1h_read").on(
    t.geo,
    t.worker_provider,
    t.method,
    t.connection_mode,
    t.methodology_version,
    t.window_start,
  ),
  // fetchMethodLatency filters worker_provider='__all__' + methodology_version
  // + window_start with NO geo — the geo-leading `read` index can't serve it.
  // See migration 0016.
  method_latency: index("leaderboard_agg_1h_method_latency").on(
    t.worker_provider,
    t.methodology_version,
    t.window_start,
  ),
}));

export const leaderboard_agg_1d = pgTable("leaderboard_agg_1d", leaderboardAggColumns(), (t) => ({
  pk: primaryKey({
    columns: [
      t.geo,
      t.worker_provider,
      t.provider_id,
      t.method,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ],
  }),
  read: index("leaderboard_agg_1d_read").on(
    t.geo,
    t.worker_provider,
    t.method,
    t.connection_mode,
    t.methodology_version,
    t.window_start,
  ),
  // See leaderboard_agg_1h.method_latency + migration 0016.
  method_latency: index("leaderboard_agg_1d_method_latency").on(
    t.worker_provider,
    t.methodology_version,
    t.window_start,
  ),
}));

// Companion: challenges with any winner per (geo, infra, method, mode, mv,
// time-bucket) — the win-rate denominator.
function leaderboardChallengesColumns() {
  return {
    geo: text("geo").notNull(),
    worker_provider: text("worker_provider").notNull(),
    method: text("method").notNull(),
    connection_mode: text("connection_mode").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    window_start: timestamp("window_start", { withTimezone: true }).notNull(),
    n_challenges: integer("n_challenges").notNull(),
  };
}

export const leaderboard_challenges_1h = pgTable(
  "leaderboard_challenges_1h",
  leaderboardChallengesColumns(),
  (t) => ({
    pk: primaryKey({
      columns: [
        t.geo,
        t.worker_provider,
        t.method,
        t.connection_mode,
        t.methodology_version,
        t.window_start,
      ],
    }),
  }),
);

export const leaderboard_challenges_1d = pgTable(
  "leaderboard_challenges_1d",
  leaderboardChallengesColumns(),
  (t) => ({
    pk: primaryKey({
      columns: [
        t.geo,
        t.worker_provider,
        t.method,
        t.connection_mode,
        t.methodology_version,
        t.window_start,
      ],
    }),
  }),
);

// Companion: per-failure-category counts at the agg grain — the breakdown
// behind a provider's missing success %. Counted under the same scf predicate
// as sample_count_failed, so SUM(n) reconciles with the agg's failed count.
function leaderboardFailuresColumns() {
  return {
    geo: text("geo").notNull(),
    worker_provider: text("worker_provider").notNull(),
    provider_id: text("provider_id").notNull(),
    method: text("method").notNull(),
    connection_mode: text("connection_mode").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    window_start: timestamp("window_start", { withTimezone: true }).notNull(),
    failure_category: text("failure_category").notNull(),
    n: integer("n").notNull(),
  };
}

export const leaderboard_failures_1h = pgTable(
  "leaderboard_failures_1h",
  leaderboardFailuresColumns(),
  (t) => ({
    pk: primaryKey({
      columns: [
        t.geo,
        t.worker_provider,
        t.provider_id,
        t.method,
        t.connection_mode,
        t.methodology_version,
        t.window_start,
        t.failure_category,
      ],
    }),
    read: index("leaderboard_failures_1h_read").on(
      t.geo,
      t.worker_provider,
      t.method,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ),
  }),
);

export const leaderboard_failures_1d = pgTable(
  "leaderboard_failures_1d",
  leaderboardFailuresColumns(),
  (t) => ({
    pk: primaryKey({
      columns: [
        t.geo,
        t.worker_provider,
        t.provider_id,
        t.method,
        t.connection_mode,
        t.methodology_version,
        t.window_start,
        t.failure_category,
      ],
    }),
    read: index("leaderboard_failures_1d_read").on(
      t.geo,
      t.worker_provider,
      t.method,
      t.connection_mode,
      t.methodology_version,
      t.window_start,
    ),
  }),
);

// Precomputed latency-distribution histograms (migration 0019). One row per
// (geo, infra-or-'__all__', provider, method, mode, mv, bucket): a sparse JSONB
// bin map { "<1..60>": count } over the shared log domain (packages/shared/
// histogram.ts), plus the exact count + min. Bins are additive across buckets,
// so a window read sums the maps → density / CDF / box. Feeds the Performance
// "Latency distribution" metric. _1h ≤7d, _1d beyond.
function latencyHistogramColumns() {
  return {
    geo: text("geo").notNull(),
    worker_provider: text("worker_provider").notNull(),
    provider_id: text("provider_id").notNull(),
    method: text("method").notNull(),
    connection_mode: text("connection_mode").notNull(),
    methodology_version: smallint("methodology_version").notNull(),
    window_start: timestamp("window_start", { withTimezone: true }).notNull(),
    bins: jsonb("bins").notNull(),
    n: integer("n").notNull(),
    min_ms: integer("min_ms"),
  };
}

export const latency_histogram_1h = pgTable("latency_histogram_1h", latencyHistogramColumns(), (t) => ({
  pk: primaryKey({
    columns: [t.geo, t.worker_provider, t.provider_id, t.method, t.connection_mode, t.methodology_version, t.window_start],
  }),
  read: index("latency_histogram_1h_read").on(t.worker_provider, t.method, t.connection_mode, t.window_start),
}));

export const latency_histogram_1d = pgTable("latency_histogram_1d", latencyHistogramColumns(), (t) => ({
  pk: primaryKey({
    columns: [t.geo, t.worker_provider, t.provider_id, t.method, t.connection_mode, t.methodology_version, t.window_start],
  }),
  read: index("latency_histogram_1d_read").on(t.worker_provider, t.method, t.connection_mode, t.window_start),
}));
