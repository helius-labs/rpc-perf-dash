/**
 * Rollup loop, folded into the generator process.
 *
 * The rollup runs in-process with the generator, which already holds the DB
 * connection and the leader-election advisory lock — so it gets the same HA
 * story for free (only the active generator runs rollups).
 *
 * Cadence:
 *   - rollups_5m + partition maintenance + eligibility refresh: every 5 min
 *   - rollups grain='1h': every 5 min (cheap because of upsert)
 *   - rollups grain='1d': every 5 min (same)
 *
 * All run inside an advisory lock via the generator-leader path, so a hot
 * standby never double-writes.
 */

import { sql, type SQL } from "drizzle-orm";
import { type DbClient, executeRows } from "@rpcbench/db";
import { GEO_REGION_MAP, LATENCY_HIST } from "@rpcbench/shared";

// Eligibility thresholds. TEST_MODE=1 loosens them so a fresh local run
// produces a renderable leaderboard within minutes instead of 24h. Never
// set TEST_MODE=1 in production — it weakens the public eligibility gate.
//
// Read via getter functions (not const) because the env file is loaded
// AFTER ES module imports — top-level constants would freeze at module
// load (when TEST_MODE is still undefined) and never see the loaded value.
function isTestMode(): boolean {
  return process.env.TEST_MODE === "1";
}
function eligibilityThresholds() {
  const test = isTestMode();
  // Eligibility gate. These ARE the published methodology thresholds — see
  // docs/methodology.md § "Who qualifies" (4h window, ≥50 valid samples per
  // provider × method × region, ≥0.8 reliability, ≥0.8 correctness, ≥0.95
  // honeypot Wilson lower bound). The doc is the contract: any change here
  // must land with a paired methodology.md update. TEST_MODE loosens the
  // gate for local runs only.
  return {
    window_hours: test ? 1 : 4,
    min_valid_samples: test ? 3 : 50,
    min_reliability: test ? 0.3 : 0.8,
    min_correctness: test ? 0.3 : 0.8,
    min_honeypot_pass_lb: test ? 0.0 : 0.95,
  };
}

export const ROLLUP_INTERVAL_MS = 5 * 60 * 1000;

async function ensureWilsonFunction(db: DbClient): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION wilson_lower_bound(passes int, total int, z double precision)
    RETURNS real LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE
      p double precision;
      n double precision;
      denom double precision;
      center double precision;
      margin double precision;
    BEGIN
      IF total IS NULL OR total = 0 THEN RETURN 1.0; END IF;
      n := total;
      p := passes::double precision / n;
      denom := 1 + z*z/n;
      center := p + z*z/(2*n);
      margin := z * sqrt((p*(1-p) + z*z/(4*n)) / n);
      RETURN ((center - margin) / denom)::real;
    END $$;
  `);
}

// The metric columns every tier writes, in INSERT order. The group keys +
// window_start precede these in both the INSERT list and the SELECT.
const ROLLUP_METRIC_COLUMNS = sql.raw(`
  sample_count_total, sample_count_valid, sample_count_excluded,
  latency_p50, latency_p95, latency_p99, latency_stddev,
  success_rate, correctness_rate, completeness_rate,
  freshness_avg_lag, freshness_p95_lag,
  honeypot_pass_count, honeypot_total
`);

// The matching SELECT expressions for ROLLUP_METRIC_COLUMNS, same order.
const ROLLUP_METRIC_SELECT = sql.raw(`
  count(*)::int,
  count(*) FILTER (WHERE correctness = 'correct')::int,
  count(*) FILTER (WHERE correctness != 'correct')::int,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::int,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::int,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::int,
  stddev_samp(latency_ms::float),
  (avg(CASE WHEN status = 'ok' AND correctness != 'ambiguous' THEN 1.0 ELSE 0.0 END)
   FILTER (WHERE exclusion_reason IS NULL
     OR exclusion_reason NOT IN ('freshness_ahead', 'operational_error')))::real,
  -- Correctness denominator excludes status != 'ok' (timeouts / network errors):
  -- those are a *reliability* failure, not a *data* failure, so counting them here
  -- would double-penalize timeout-prone providers (low R and low C from one sample).
  (count(*) FILTER (WHERE status = 'ok' AND correctness = 'correct')::real
   / NULLIF(count(*) FILTER (WHERE status = 'ok' AND correctness IN ('correct', 'incorrect', 'stale'))::real, 0)),
  (count(*) FILTER (WHERE correctness IN ('correct', 'stale', 'incorrect'))::real
   / NULLIF(count(*) FILTER (WHERE correctness != 'ambiguous')::real, 0)),
  avg(freshness_lag)::real,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY freshness_lag)::int,
  count(*) FILTER (WHERE is_honeypot AND correctness = 'correct')::int,
  count(*) FILTER (WHERE is_honeypot)::int
`);

// The DO UPDATE SET for every metric column. Defining it once is the whole
// point: a prior copy-paste had 1h/1d omit sample_count_excluded /
// freshness_avg_lag (and 1d latency_stddev), freezing them on bucket re-fold.
const ROLLUP_METRIC_UPDATE = sql.raw(`
  sample_count_total    = EXCLUDED.sample_count_total,
  sample_count_valid    = EXCLUDED.sample_count_valid,
  sample_count_excluded = EXCLUDED.sample_count_excluded,
  latency_p50           = EXCLUDED.latency_p50,
  latency_p95           = EXCLUDED.latency_p95,
  latency_p99           = EXCLUDED.latency_p99,
  latency_stddev        = EXCLUDED.latency_stddev,
  success_rate          = EXCLUDED.success_rate,
  correctness_rate      = EXCLUDED.correctness_rate,
  completeness_rate     = EXCLUDED.completeness_rate,
  freshness_avg_lag     = EXCLUDED.freshness_avg_lag,
  freshness_p95_lag     = EXCLUDED.freshness_p95_lag,
  honeypot_pass_count   = EXCLUDED.honeypot_pass_count,
  honeypot_total        = EXCLUDED.honeypot_total
`);

// Per-job GUCs for the heavy build scans. statement_timeout bounds a runaway
// query's runtime (so a pathological sort is killed instead of spilling for
// ~800s and filling the compute's temp disk — the failure mode that took the
// site down); work_mem gives the percentile sorts enough memory to mostly stay
// off disk. MUST be SET LOCAL inside a transaction: Neon's transaction pooler
// doesn't persist a session SET across pooled checkouts.
//
// NOTE: we deliberately do NOT set temp_file_limit here — it's a superuser-only
// (SUSET) GUC and Neon's owner role can't set it (raises 42501). The disk-fill
// guard is therefore statement_timeout + the reduced scan footprint (explicit
// projection, 1-day lookback); if a hard temp cap is needed it must be set on
// the Neon compute via the console/API, not from the app.
//
// work_mem stays at 128MB — never raise the global/role default, which would
// multiply across all 20 pooled connections and itself cause OOM; the heavy jobs
// are serialized by their own in-flight guards in index.ts so concurrent 128MB
// allocations are bounded.
async function withHeavyGucs(
  db: DbClient,
  body: (tx: RollupTx) => Promise<unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL work_mem = '128MB'`);
    // 600s, not a tight cap: the legit leaderboard build (percentile GROUPING
    // SETS + the ranked/wins window sorts over a day of correct samples) runs
    // ~40s warm for the agg alone and more cold / on a small compute / under
    // dispatch contention — 120s timed it out at startup. 600s still kills the
    // pathological runaway (the original ~800s unbounded spill) but lets the
    // bounded post-A1/A2 build finish.
    await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
    await body(tx);
  });
}

// Folds eligible samples into one rollup tier. The tiers differ only in target
// table, how started_at is bucketed into window_start, and the time filter;
// the aggregates and upsert columns are shared above so they can't drift apart.
// Wrapped in withHeavyGucs — rollup1h/1d scan a multi-hour/day sample range and
// percentile-sort it; rollup5m shares this path and harmlessly inherits the
// bounded GUCs (its 15-min scan never approaches them).
async function rollupTier(
  db: DbClient,
  opts: {
    // rollups_5m stays its own table (no grain column); the long-window 1h/1d
    // tiers share the merged `rollups` table, discriminated by `grain`.
    table: "rollups_5m" | "rollups";
    grain?: "1h" | "1d";
    windowStart: SQL;
    timeFilter: SQL;
  },
): Promise<void> {
  const grainCol = opts.grain ? sql.raw("grain, ") : sql.raw("");
  const grainVal = opts.grain ? sql.raw(`'${opts.grain}', `) : sql.raw("");
  await withHeavyGucs(db, (tx) => tx.execute(sql`
    INSERT INTO ${sql.raw(opts.table)} (
      ${grainCol}provider_id, method, worker_provider, region, bucket, connection_mode, methodology_version, window_start,
      ${ROLLUP_METRIC_COLUMNS}
    )
    SELECT
      ${grainVal}provider_id, method, worker_provider, region, bucket, connection_mode, methodology_version,
      ${opts.windowStart} AS window_start,
      ${ROLLUP_METRIC_SELECT}
    FROM samples
    WHERE ${opts.timeFilter}
    GROUP BY provider_id, method, worker_provider, region, bucket, connection_mode, methodology_version, window_start
    ON CONFLICT (${grainCol}provider_id, method, worker_provider, region, bucket, connection_mode, methodology_version, window_start)
    DO UPDATE SET ${ROLLUP_METRIC_UPDATE}
  `));
}

async function rollup5m(db: DbClient): Promise<void> {
  await rollupTier(db, {
    table: "rollups_5m",
    windowStart: sql`date_trunc('hour', started_at) + floor(extract(minute from started_at) / 5) * interval '5 min'`,
    timeFilter: sql`started_at >= now() - interval '15 min' AND started_at < date_trunc('minute', now())`,
  });
}

export async function rollup1h(db: DbClient, lookback = "2 hours"): Promise<void> {
  await rollupTier(db, {
    table: "rollups",
    grain: "1h",
    windowStart: sql`date_trunc('hour', started_at)`,
    // include the current incomplete hour too; ON CONFLICT DO UPDATE keeps it fresh
    timeFilter: sql`started_at >= date_trunc('hour', now()) - interval ${sql.raw(`'${lookback}'`)}`,
  });
}

export async function rollup1d(db: DbClient, lookback = "1 day"): Promise<void> {
  await rollupTier(db, {
    table: "rollups",
    grain: "1d",
    windowStart: sql`date_trunc('day', started_at)`,
    // Re-fold only the current incomplete day + the just-closed day (lookback
    // "1 day" → floor = start of yesterday). Closed days never change beyond the
    // <2-min late-writer window, so re-scanning more is wasted work; the old
    // "2 days" floor actually spanned 3 calendar days of raw samples every tick.
    // ON CONFLICT DO UPDATE keeps both live buckets fresh.
    timeFilter: sql`started_at >= date_trunc('day', now()) - interval ${sql.raw(`'${lookback}'`)}`,
  });
}

// Retention is tiered to exactly what the dashboard reads (see
// apps/web/src/lib/chartData.ts table-selection): rollups_5m only feeds charts
// ≤24h (and the eligibility refresh's 4h window), so 2 days is ample buffer.
// The merged `rollups` table feeds the rest: grain='1h' → 24h–7d, grain='1d' →
// >7d–30d. Retaining rollups_5m for the full 30d would store ~15× more 5m rows
// than anything queries.
async function pruneOldRollups5m(db: DbClient): Promise<void> {
  await db.execute(sql`DELETE FROM rollups_5m WHERE window_start < now() - interval '2 days'`);
}

// Per-grain retention on the merged table: hourly buckets past 8d and daily
// past 31d. Grain-scoped so each tier keeps its own horizon.
async function pruneOldRollups1h1d(db: DbClient): Promise<void> {
  await db.execute(sql`DELETE FROM rollups WHERE grain = '1h' AND window_start < now() - interval '8 days'`);
  await db.execute(sql`DELETE FROM rollups WHERE grain = '1d' AND window_start < now() - interval '31 days'`);
}

function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Inline (worker_provider, region) → geo relation built from GEO_REGION_MAP
 * (packages/shared), for use as a JOIN target in the leaderboard precompute.
 * This is the single source of truth the precompute JOINs against, so its SQL
 * grouping can never drift from the FE's geoRegionOf mapping. It replaces the
 * former geo_region_map table (~50 rows) with an in-memory VALUES relation, so
 * there is nothing to seed — the mapping is compiled straight from the code
 * constant on every query. Returns a
 * `(VALUES …) AS grm(worker_provider, region, geo)` fragment for `sql.raw`.
 */
function geoRegionValuesSql(): string {
  const values: string[] = [];
  for (const [workerProvider, regions] of Object.entries(GEO_REGION_MAP)) {
    for (const [region, geo] of Object.entries(regions)) {
      values.push(`(${sqlLit(workerProvider)}, ${sqlLit(region)}, ${sqlLit(geo)})`);
    }
  }
  return `(VALUES ${values.join(",")}) AS grm(worker_provider, region, geo)`;
}

/**
 * Recompute the leaderboard precompute for one grain (hourly feeds the 7d view,
 * daily feeds 30d). Mirrors rollup1h/1d: a full-bucket recompute over a trailing
 * lookback, delete-then-insert so dropped winners/providers leave no stale row.
 *
 * The key accuracy property: percentiles are computed over the POOLED geo (or
 * geo+infra) samples per time bucket — NOT averaged from the fine-grained
 * rollups — so each stored percentile is over enough samples to be meaningful.
 * The >24h leaderboard read then weight-averages across time buckets only.
 *
 * Rows are emitted at two infra scopes via GROUPING SETS:
 *   - worker_provider = '__all__'  → pooled across every cloud in the geo
 *   - worker_provider = <concrete> → one scope per infra present
 * Winners (lowest-latency correct sample per challenge within the scope) are
 * computed exactly with window functions and stored as n_wins per bucket, with
 * the challenge count (rate denominator) in the companion table.
 *
 * `trunc` is 'hour'|'day' and `lookback` is a Postgres interval literal — both
 * are code-chosen constants spliced via sql.raw, never user input.
 */
export async function rollupLeaderboard(
  db: DbClient,
  grain: "1h" | "1d",
  trunc: "hour" | "day",
  lookback: string,
): Promise<void> {
  const floor = sql`date_trunc(${sql.raw(`'${trunc}'`)}, now()) - interval ${sql.raw(`'${lookback}'`)}`;
  // Bucket expression used inside the `agg`/`ranked` CTEs, which select FROM
  // `base` (no `s` alias there — base exposes the bare column names via s.*).
  const bucket = sql`date_trunc(${sql.raw(`'${trunc}'`)}, started_at)`;
  // The four precompute tables are now single merged tables discriminated by
  // `grain`; every write/delete below is scoped to this grain. grain is a
  // code-chosen constant ('1h'|'1d'), spliced via sql.raw, never user input.
  const grainVal = sql.raw(`'${grain}'`);
  const aggT = sql.raw("leaderboard_agg");
  const chalT = sql.raw("leaderboard_challenges");
  const failT = sql.raw("leaderboard_failures");
  const histT = sql.raw("latency_histogram");

  // All deletes + re-inserts run in ONE transaction so concurrent runs (the
  // 5-min generator tick and the one-off long-window backfill) serialize
  // cleanly, and dashboard readers keep seeing the previous complete snapshot
  // (MVCC) instead of an empty table mid-rewrite.
  //
  // Delete-then-insert alone is NOT collision-proof under concurrency: if a
  // second writer's DELETE runs before the first's COMMIT, it won't see (and so
  // won't delete) the first writer's about-to-commit rows, and its INSERT then
  // hits a duplicate-key violation on the PK. This is exactly what fires during
  // a generator leader handoff (the old + new leader both kick the precompute).
  // Each INSERT below therefore carries ON CONFLICT DO UPDATE as the safety net
  // — last-writer-wins per key. (The agg/chal/fail SELECTs are each unique on
  // their PK, so DO UPDATE never "affects a row a second time".)
  await db.transaction(async (tx) => {
    // Bound memory/runtime for the geo-pooled sample scans below (see
    // withHeavyGucs): statement_timeout kills a runaway percentile sort instead
    // of letting it spill for minutes. (No temp_file_limit — SUSET, can't be set
    // by Neon's owner role.)
    await tx.execute(sql`SET LOCAL work_mem = '128MB'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
    // Delete the buckets we're about to rewrite (delete-then-insert), then
    // re-fold each precompute table. Each step is its own helper below; all
    // share the same floor/bucket so they cover identical windows.
    await tx.execute(sql`DELETE FROM ${aggT}  WHERE grain = ${grainVal} AND window_start >= ${floor}`);
    await tx.execute(sql`DELETE FROM ${chalT} WHERE grain = ${grainVal} AND window_start >= ${floor}`);
    await tx.execute(sql`DELETE FROM ${failT} WHERE grain = ${grainVal} AND window_start >= ${floor}`);
    await tx.execute(sql`DELETE FROM ${histT} WHERE grain = ${grainVal} AND window_start >= ${floor}`);
    await tx.execute(sql`DELETE FROM pairwise_wins WHERE grain = ${grainVal} AND window_start >= ${floor}`);

    const scope = { floor, bucket, winBucket: bucket, grainVal, aggT, chalT, failT, histT };
    await insertLeaderboardAgg(tx, scope);
    await insertChallengeCounts(tx, scope);
    await insertFailureBreakdown(tx, scope);
    await insertLatencyHistograms(tx, scope);
    await insertPairwiseWins(tx, scope);
  });
}

/** Transaction handle passed to the per-table leaderboard fold helpers. */
type RollupTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * Shared inputs for the per-table folds. `bucket` and `winBucket` are both
 * `date_trunc(trunc, started_at)` (the winBucket alias documents the win-tally
 * CTE's use); the `*T` fields are the sql.raw target table names.
 */
interface LeaderboardScope {
  floor: SQL;
  bucket: SQL;
  winBucket: SQL;
  /** The grain literal ('1h'|'1d') this fold writes, spliced into INSERT/ON CONFLICT. */
  grainVal: SQL;
  aggT: SQL;
  chalT: SQL;
  failT: SQL;
  histT: SQL;
}

/** Aggregates (correct-only percentiles + counts) at both infra scopes, joined
 *  to the per-bucket win tally. */
async function insertLeaderboardAgg(tx: RollupTx, s: LeaderboardScope): Promise<void> {
  const { floor, bucket, winBucket, grainVal, aggT } = s;
  await tx.execute(sql`
    WITH base AS (
      -- Explicit projection (NOT s.*): keep raw_response and the other wide
      -- columns out of the materialized CTE so GROUPING SETS + the window
      -- functions + percentile sorts below don't drag a KB–MB JSONB per row.
      -- Columns are exactly those the agg/ranked/wins CTEs consume; region is a
      -- JOIN key only. Update this list if a downstream metric needs a new column.
      SELECT s.provider_id, s.method, s.connection_mode, s.methodology_version,
             s.worker_provider, s.latency_ms, s.correctness, s.status,
             s.exclusion_reason,
             s.is_honeypot, s.freshness_lag, s.started_at, s.challenge_id,
             grm.geo AS geo_r
      FROM samples s
      JOIN ${sql.raw(geoRegionValuesSql())}
        ON grm.worker_provider = s.worker_provider AND grm.region = s.region
      WHERE s.started_at >= ${floor}
    ),
    agg AS (
      SELECT
        geo_r AS geo,
        CASE WHEN GROUPING(worker_provider) = 1 THEN '__all__' ELSE worker_provider END AS worker_provider,
        provider_id, method, connection_mode, methodology_version,
        ${bucket} AS window_start,
        (percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE correctness = 'correct'))::int AS p50,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE correctness = 'correct'))::int AS p95,
        (percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE correctness = 'correct'))::int AS p99,
        stddev_samp(latency_ms::float) FILTER (WHERE correctness = 'correct')                       AS stddev,
        count(*) FILTER (WHERE correctness = 'correct')::int                                         AS scv,
        count(*)::int                                                                               AS sct,
        count(*) FILTER (WHERE correctness != 'ambiguous' AND (status != 'ok' OR correctness != 'correct'))::int AS scf,
        count(*) FILTER (WHERE is_honeypot AND correctness = 'correct')::int                         AS hpc,
        count(*) FILTER (WHERE is_honeypot)::int                                                     AS hpt,
        count(*) FILTER (WHERE status = 'ok' AND correctness != 'ambiguous')::int                    AS succ_num,
        count(*) FILTER (WHERE status = 'ok' AND correctness = 'correct')::int                       AS corr_num,
        count(*) FILTER (WHERE status = 'ok' AND correctness IN ('correct','incorrect','stale'))::int AS corr_den,
        count(*) FILTER (WHERE correctness IN ('correct','stale','incorrect'))::int                  AS comp_num,
        count(*) FILTER (WHERE correctness != 'ambiguous')::int                                      AS comp_den,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY freshness_lag))::int                           AS fresh,
        -- No-fault exclusions (out of both C and R) — the web leaderboard subtracts
        -- this from the reliability denominator (sample_count_total). See Fix 1/3.
        count(*) FILTER (WHERE exclusion_reason IN ('freshness_ahead', 'operational_error'))::int    AS nofault
      FROM base
      GROUP BY GROUPING SETS (
        (geo_r, provider_id, method, connection_mode, methodology_version, ${bucket}),
        (geo_r, worker_provider, provider_id, method, connection_mode, methodology_version, ${bucket})
      )
    ),
    ranked AS (
      SELECT geo_r, worker_provider, provider_id, method, connection_mode, methodology_version,
        started_at, challenge_id,
        row_number() OVER (PARTITION BY geo_r, method, connection_mode, methodology_version, challenge_id
                           ORDER BY latency_ms ASC, started_at ASC) AS rn_all,
        row_number() OVER (PARTITION BY geo_r, worker_provider, method, connection_mode, methodology_version, challenge_id
                           ORDER BY latency_ms ASC, started_at ASC) AS rn_infra
      FROM base
      WHERE correctness = 'correct'
    ),
    wins AS (
      SELECT geo_r AS geo, '__all__' AS worker_provider, provider_id, method, connection_mode, methodology_version,
        ${winBucket} AS window_start, count(*)::int AS n_wins
      FROM ranked WHERE rn_all = 1
      GROUP BY geo_r, provider_id, method, connection_mode, methodology_version, ${winBucket}
      UNION ALL
      SELECT geo_r, worker_provider, provider_id, method, connection_mode, methodology_version,
        ${winBucket}, count(*)::int
      FROM ranked WHERE rn_infra = 1
      GROUP BY geo_r, worker_provider, provider_id, method, connection_mode, methodology_version, ${winBucket}
    )
    INSERT INTO ${aggT} (
      grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start,
      latency_p50_correct, latency_p95_correct, latency_p99_correct, latency_stddev,
      sample_count_valid, sample_count_total, sample_count_failed,
      honeypot_pass_count, honeypot_total,
      success_num, correctness_num, correctness_den, completeness_num, completeness_den,
      freshness_p95_lag, n_wins, nofault_excluded_count
    )
    SELECT
      ${grainVal}, agg.geo, agg.worker_provider, agg.provider_id, agg.method, agg.connection_mode, agg.methodology_version, agg.window_start,
      agg.p50, agg.p95, agg.p99, agg.stddev,
      agg.scv, agg.sct, agg.scf, agg.hpc, agg.hpt,
      agg.succ_num, agg.corr_num, agg.corr_den, agg.comp_num, agg.comp_den,
      agg.fresh, COALESCE(w.n_wins, 0), agg.nofault
    FROM agg
    LEFT JOIN wins w
      ON  w.geo = agg.geo
      AND w.worker_provider = agg.worker_provider
      AND w.provider_id = agg.provider_id
      AND w.method = agg.method
      AND w.connection_mode = agg.connection_mode
      AND w.methodology_version = agg.methodology_version
      AND w.window_start = agg.window_start
    ON CONFLICT (grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
    DO UPDATE SET
      latency_p50_correct = EXCLUDED.latency_p50_correct,
      latency_p95_correct = EXCLUDED.latency_p95_correct,
      latency_p99_correct = EXCLUDED.latency_p99_correct,
      latency_stddev      = EXCLUDED.latency_stddev,
      sample_count_valid  = EXCLUDED.sample_count_valid,
      sample_count_total  = EXCLUDED.sample_count_total,
      sample_count_failed = EXCLUDED.sample_count_failed,
      honeypot_pass_count = EXCLUDED.honeypot_pass_count,
      honeypot_total      = EXCLUDED.honeypot_total,
      success_num         = EXCLUDED.success_num,
      correctness_num     = EXCLUDED.correctness_num,
      correctness_den     = EXCLUDED.correctness_den,
      completeness_num    = EXCLUDED.completeness_num,
      completeness_den    = EXCLUDED.completeness_den,
      freshness_p95_lag   = EXCLUDED.freshness_p95_lag,
      n_wins              = EXCLUDED.n_wins,
      nofault_excluded_count = EXCLUDED.nofault_excluded_count
  `);
}

/**
 * Head-to-head (A-vs-B) win counts per provider pair. For each challenge that
 * BOTH providers answered correctly, the faster-latency provider (ties → earlier
 * started_at, matching the global winner ordering in `ranked` above) takes the
 * win. Pairs are canonical/unordered (provider_a < provider_b); a_wins/b_wins are
 * the alphabetically-first / -second provider's wins, and n_contested = the
 * contested-challenge count (= a_wins + b_wins by construction, ties → b).
 *
 * The bucket is computed once in `best` (single relation `base`, so bare
 * started_at is unambiguous) and read as x.window_start in the self-join — do
 * NOT reuse winBucket inside `pairs`, its bare started_at would be ambiguous
 * across best x JOIN best y.
 *
 * Cost note: this adds one extra base-samples scan per grain on top of the agg
 * fold; the self-join is over the small `best` set (one row per provider /
 * challenge). If the leaderboard tick regresses toward the 600s cap, split this
 * onto its own interval + transaction.
 */
async function insertPairwiseWins(tx: RollupTx, s: LeaderboardScope): Promise<void> {
  const { floor, bucket, grainVal } = s;
  await tx.execute(sql`
    WITH base AS (
      -- Explicit projection (NOT s.*): only the columns the best/pairs CTEs need,
      -- correct-only (a pairwise win requires a correct answer from both).
      SELECT s.provider_id, s.method, s.connection_mode, s.methodology_version,
             s.latency_ms, s.started_at, s.challenge_id,
             grm.geo AS geo_r
      FROM samples s
      JOIN ${sql.raw(geoRegionValuesSql())}
        ON grm.worker_provider = s.worker_provider AND grm.region = s.region
      WHERE s.started_at >= ${floor}
        AND s.correctness = 'correct'
    ),
    best AS (
      -- One representative (fastest, then earliest) correct sample per provider
      -- per challenge. window_start is derived here where started_at is
      -- unambiguous (single relation base).
      SELECT geo_r, method, connection_mode, methodology_version, challenge_id,
             provider_id, latency_ms, started_at,
             ${bucket} AS window_start,
             row_number() OVER (
               PARTITION BY geo_r, method, connection_mode, methodology_version, challenge_id, provider_id
               ORDER BY latency_ms ASC, started_at ASC) AS rn
      FROM base
    ),
    pairs AS (
      -- Self-join → every unordered provider pair that both answered the same
      -- challenge. Bucket taken from provider_a's representative sample.
      SELECT x.geo_r AS geo, x.method, x.connection_mode, x.methodology_version,
             x.window_start AS window_start,
             x.provider_id AS provider_a, y.provider_id AS provider_b,
             -- mirror ORDER BY latency_ms ASC, started_at ASC; only a residual
             -- (equal latency AND equal started_at) tie falls to b.
             (x.latency_ms < y.latency_ms
              OR (x.latency_ms = y.latency_ms AND x.started_at < y.started_at)) AS a_won
      FROM best x JOIN best y
        ON x.challenge_id = y.challenge_id AND x.geo_r = y.geo_r AND x.method = y.method
           AND x.connection_mode = y.connection_mode AND x.methodology_version = y.methodology_version
      WHERE x.rn = 1 AND y.rn = 1 AND x.provider_id < y.provider_id
    )
    INSERT INTO pairwise_wins (
      grain, geo, provider_a, provider_b, method, connection_mode, methodology_version, window_start,
      a_wins, b_wins, n_contested
    )
    SELECT ${grainVal}, geo, provider_a, provider_b, method, connection_mode, methodology_version, window_start,
      count(*) FILTER (WHERE a_won)::int, count(*) FILTER (WHERE NOT a_won)::int, count(*)::int
    FROM pairs
    GROUP BY geo, provider_a, provider_b, method, connection_mode, methodology_version, window_start
    ON CONFLICT (grain, geo, provider_a, provider_b, method, connection_mode, methodology_version, window_start)
    DO UPDATE SET
      a_wins      = EXCLUDED.a_wins,
      b_wins      = EXCLUDED.b_wins,
      n_contested = EXCLUDED.n_contested
  `);
}

/** Companion challenge counts (rate denominator) at both infra scopes. */
async function insertChallengeCounts(tx: RollupTx, s: LeaderboardScope): Promise<void> {
  const { floor, winBucket, grainVal, chalT } = s;
  await tx.execute(sql`
    WITH base AS (
      -- Explicit projection (NOT s.*): only the columns the ranked/win-count
      -- CTE needs, so raw_response never enters the materialized set / sort.
      SELECT s.worker_provider, s.method, s.connection_mode, s.methodology_version,
             s.started_at, s.latency_ms, s.challenge_id,
             grm.geo AS geo_r
      FROM samples s
      JOIN ${sql.raw(geoRegionValuesSql())}
        ON grm.worker_provider = s.worker_provider AND grm.region = s.region
      WHERE s.started_at >= ${floor}
        AND s.correctness = 'correct'
    ),
    ranked AS (
      SELECT geo_r, worker_provider, method, connection_mode, methodology_version, started_at,
        row_number() OVER (PARTITION BY geo_r, method, connection_mode, methodology_version, challenge_id
                           ORDER BY latency_ms ASC, started_at ASC) AS rn_all,
        row_number() OVER (PARTITION BY geo_r, worker_provider, method, connection_mode, methodology_version, challenge_id
                           ORDER BY latency_ms ASC, started_at ASC) AS rn_infra
      FROM base
    )
    INSERT INTO ${chalT} (
      grain, geo, worker_provider, method, connection_mode, methodology_version, window_start, n_challenges
    )
    SELECT ${grainVal}, geo_r, '__all__', method, connection_mode, methodology_version, ${winBucket}, count(*)::int
    FROM ranked WHERE rn_all = 1
    GROUP BY geo_r, method, connection_mode, methodology_version, ${winBucket}
    UNION ALL
    SELECT ${grainVal}, geo_r, worker_provider, method, connection_mode, methodology_version, ${winBucket}, count(*)::int
    FROM ranked WHERE rn_infra = 1
    GROUP BY geo_r, worker_provider, method, connection_mode, methodology_version, ${winBucket}
    ON CONFLICT (grain, geo, worker_provider, method, connection_mode, methodology_version, window_start)
    DO UPDATE SET n_challenges = EXCLUDED.n_challenges
  `);
}

/**
 * Companion failure breakdown: per-failure_category counts at both infra scopes.
 * The WHERE clause is the EXACT scf predicate the agg uses for
 * sample_count_failed, so SUM(n) per window reconciles with the agg's failed
 * count (the breakdown adds up to the missing success %). The
 * `failure_category IS NOT NULL` guard drops pre-0006 backfilled failures (NULL
 * category) so they can't violate the table's NOT NULL key — those buckets
 * undercount rather than error.
 */
async function insertFailureBreakdown(tx: RollupTx, s: LeaderboardScope): Promise<void> {
  const { floor, bucket, grainVal, failT } = s;
  await tx.execute(sql`
    WITH base AS (
      -- Explicit projection (NOT s.*): only the columns the failure GROUPING
      -- SETS need; status/correctness are filter-only (in the base WHERE), so
      -- they aren't projected and raw_response never enters the set.
      SELECT s.provider_id, s.method, s.connection_mode, s.methodology_version,
             s.worker_provider, s.failure_category, s.started_at,
             grm.geo AS geo_r
      FROM samples s
      JOIN ${sql.raw(geoRegionValuesSql())}
        ON grm.worker_provider = s.worker_provider AND grm.region = s.region
      WHERE s.started_at >= ${floor}
        AND s.failure_category IS NOT NULL
        AND s.correctness != 'ambiguous'
        AND (s.status != 'ok' OR s.correctness != 'correct')
    )
    INSERT INTO ${failT} (
      grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, failure_category, n
    )
    SELECT
      ${grainVal},
      geo_r AS geo,
      CASE WHEN GROUPING(worker_provider) = 1 THEN '__all__' ELSE worker_provider END AS worker_provider,
      provider_id, method, connection_mode, methodology_version,
      ${bucket} AS window_start,
      failure_category,
      count(*)::int AS n
    FROM base
    GROUP BY GROUPING SETS (
      (geo_r, provider_id, method, connection_mode, methodology_version, ${bucket}, failure_category),
      (geo_r, worker_provider, provider_id, method, connection_mode, methodology_version, ${bucket}, failure_category)
    )
    ON CONFLICT (grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, failure_category)
    DO UPDATE SET n = EXCLUDED.n
  `);
}

/**
 * Latency-distribution histograms (correct-only) at both infra scopes. Each row
 * holds a sparse JSONB bin map { "<1..60>": count } over the shared log domain
 * plus the exact count + min. width_bucket is clamped to [1, NBINS] so the tails
 * fall in the edge bins and Σ bins == n. Feeds the "Latency distribution" metric.
 */
async function insertLatencyHistograms(tx: RollupTx, s: LeaderboardScope): Promise<void> {
  const { floor, bucket, grainVal, histT } = s;
  await tx.execute(sql`
    WITH base AS (
      SELECT s.provider_id, s.method, s.connection_mode, s.methodology_version,
             s.worker_provider, s.latency_ms, grm.geo AS geo_r,
             ${bucket} AS window_start,
             least(${LATENCY_HIST.NBINS}, greatest(1,
               width_bucket(ln(greatest(s.latency_ms, 1)::float), ${LATENCY_HIST.L0}, ${LATENCY_HIST.L1}, ${LATENCY_HIST.NBINS})
             )) AS bin
      FROM samples s
      JOIN ${sql.raw(geoRegionValuesSql())}
        ON grm.worker_provider = s.worker_provider AND grm.region = s.region
      WHERE s.started_at >= ${floor}
        AND s.correctness = 'correct'
        AND s.latency_ms IS NOT NULL
    ),
    counts AS (
      SELECT geo_r AS geo,
        CASE WHEN GROUPING(worker_provider) = 1 THEN '__all__' ELSE worker_provider END AS worker_provider,
        provider_id, method, connection_mode, methodology_version, window_start, bin,
        count(*)::int AS cnt, min(latency_ms)::int AS min_ms
      FROM base
      GROUP BY GROUPING SETS (
        (geo_r, provider_id, method, connection_mode, methodology_version, window_start, bin),
        (geo_r, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, bin)
      )
    )
    INSERT INTO ${histT} (
      grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start, bins, n, min_ms
    )
    SELECT ${grainVal}, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start,
      jsonb_object_agg(bin::text, cnt) AS bins,
      sum(cnt)::int AS n,
      min(min_ms)::int AS min_ms
    FROM counts
    GROUP BY geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start
    ON CONFLICT (grain, geo, worker_provider, provider_id, method, connection_mode, methodology_version, window_start)
    DO UPDATE SET bins = EXCLUDED.bins, n = EXCLUDED.n, min_ms = EXCLUDED.min_ms
  `);
}

// Retention tiered to dashboard reads: grain='1h' rows only feed windows ≤7d,
// grain='1d' rows feed >7d–30d. Keep 8d / 31d respectively (one extra day of
// buffer past each window boundary). Grain-scoped DELETEs on the merged tables.
async function pruneLeaderboard(db: DbClient): Promise<void> {
  await db.execute(sql`DELETE FROM leaderboard_agg        WHERE grain = '1h' AND window_start < now() - interval '8 days'`);
  await db.execute(sql`DELETE FROM leaderboard_agg        WHERE grain = '1d' AND window_start < now() - interval '31 days'`);
  await db.execute(sql`DELETE FROM leaderboard_challenges WHERE grain = '1h' AND window_start < now() - interval '8 days'`);
  await db.execute(sql`DELETE FROM leaderboard_challenges WHERE grain = '1d' AND window_start < now() - interval '31 days'`);
  await db.execute(sql`DELETE FROM leaderboard_failures   WHERE grain = '1h' AND window_start < now() - interval '8 days'`);
  await db.execute(sql`DELETE FROM leaderboard_failures   WHERE grain = '1d' AND window_start < now() - interval '31 days'`);
  await db.execute(sql`DELETE FROM latency_histogram      WHERE grain = '1h' AND window_start < now() - interval '8 days'`);
  await db.execute(sql`DELETE FROM latency_histogram      WHERE grain = '1d' AND window_start < now() - interval '31 days'`);
  await db.execute(sql`DELETE FROM pairwise_wins          WHERE grain = '1h' AND window_start < now() - interval '8 days'`);
  await db.execute(sql`DELETE FROM pairwise_wins          WHERE grain = '1d' AND window_start < now() - interval '31 days'`);
}

async function refreshEligibility(db: DbClient): Promise<void> {
  // Read at call time so the env-loaded TEST_MODE value applies, not the
  // module-load value (which would be undefined → production thresholds).
  const T = eligibilityThresholds();
  await withHeavyGucs(db, (tx) => tx.execute(sql`
    INSERT INTO eligibility (
      provider_id, region, method, methodology_version, window_end,
      eligible, failing_reason, n_valid, reliability, correctness, honeypot_pass_rate_lb
    )
    SELECT
      provider_id, region, method, methodology_version,
      now() AS window_end,
      (n_valid >= ${T.min_valid_samples}
       AND reliability >= ${T.min_reliability}
       AND correctness >= ${T.min_correctness}
       AND honeypot_pass_rate_lb >= ${T.min_honeypot_pass_lb}) AS eligible,
      CASE
        WHEN n_valid                < ${T.min_valid_samples}      THEN 'insufficient_samples'
        WHEN reliability            < ${T.min_reliability}         THEN 'reliability_below_threshold'
        WHEN correctness            < ${T.min_correctness}         THEN 'correctness_below_threshold'
        WHEN honeypot_pass_rate_lb  < ${T.min_honeypot_pass_lb}   THEN 'honeypot_pass_below_threshold'
        ELSE NULL
      END AS failing_reason,
      n_valid, reliability, correctness, honeypot_pass_rate_lb
    FROM (
      -- Reads from rollups_5m (always populated within 5 min of generator
      -- start) so eligibility is reachable in TEST_MODE without waiting for
      -- the first complete hour.
      SELECT
        provider_id, region, method, methodology_version,
        sum(sample_count_valid)::int                                                  AS n_valid,
        -- COALESCE to 0 — a (provider, region, method) window with zero
        -- validated samples (e.g. a method that is tier_method_unsupported
        -- for the provider: every sample → ambiguous → success/correctness
        -- rates NULL via NULLIF in the rollup) produces NULL avg() values which
        -- violated eligibility's NOT NULL constraint and crashed the entire
        -- rollup tick. With COALESCE the row gets 0/0 and fails the
        -- threshold gate, which is the right semantic — no data, no eligibility.
        COALESCE(avg(success_rate), 0)::real                                          AS reliability,
        COALESCE(avg(correctness_rate), 0)::real                                      AS correctness,
        wilson_lower_bound(
          sum(honeypot_pass_count)::int,
          sum(honeypot_total)::int,
          1.96
        )                                                                             AS honeypot_pass_rate_lb
      FROM rollups_5m
      WHERE window_start > now() - make_interval(hours => ${T.window_hours})
        AND connection_mode = 'cold'
      GROUP BY provider_id, region, method, methodology_version
    ) agg
    ON CONFLICT (provider_id, region, method, methodology_version, window_end)
    DO NOTHING
  `));
}

let testModeWarned = false;

/**
 * Fast rollup — call every 5 min on its OWN interval/guard (see index.ts).
 *
 * Folds samples → rollups_5m only. rollups_5m is the live chart's source, so
 * this must run reliably on cadence. It is deliberately isolated from the
 * heavier 1h/1d/eligibility work in `runHeavyRollups`: those read wider sample
 * ranges + percentile_cont and can outrun the 5-min interval under load. Under
 * a single shared tick + overlap guard, a slow heavy step would skip the NEXT
 * firing — including this cheap rollup5m — making the chart's latest 5-min
 * bucket advance in bursts. Splitting them keeps the chart on cadence
 * regardless of how long the heavy rollups take.
 */
export async function runRollup5m(db: DbClient): Promise<void> {
  await rollup5m(db);
}

/**
 * Heavy rollup — call every 5 min on its own interval/guard. Folds the longer
 * windows (rollups grain='1h'/'1d'), prunes rollups_5m, and refreshes
 * eligibility. Safe
 * to overrun: it only defers itself, never the fast rollup5m above.
 */
export async function runHeavyRollups(db: DbClient): Promise<void> {
  if (isTestMode() && !testModeWarned) {
    console.warn("[rollup] TEST_MODE=1 — eligibility gates loosened (NEVER use in prod)");
    testModeWarned = true;
  }
  await ensureWilsonFunction(db);
  await rollup1h(db);
  await rollup1d(db);
  await pruneOldRollups5m(db);
  await pruneOldRollups1h1d(db);
  await refreshEligibility(db);
}

/**
 * Full rollup sequence (fast + heavy). Used by the one-shot benchmark CLI
 * (benchmark.ts), which wants every grain folded before printing results. The
 * live generator instead schedules `runRollup5m` and `runHeavyRollups` on
 * SEPARATE intervals (see index.ts) so the fast 5m bucket can't be starved by
 * the heavy work.
 */
export async function runRollupTick(db: DbClient): Promise<void> {
  await runRollup5m(db);
  await runHeavyRollups(db);
}

/**
 * Leaderboard precompute (long-window perf), decoupled from `runRollupTick`.
 * Seeds the geo map, then recomputes the trailing 2h (hourly) / 1d (daily) of
 * the (geo, infra, provider, ...) aggregates + win-counts the >24h leaderboard
 * reads. Older buckets persist from earlier runs / backfill.
 *
 * Runs on its own interval with its own overlap guard, so even when this
 * outruns the 5-min cadence it only defers itself — never the fast rollup tick.
 * Reads `samples` only (the geo map is an inline VALUES relation, see
 * geoRegionValuesSql); shares no write target with the fast tick, so concurrent
 * execution is safe.
 */
export async function runLeaderboardPrecompute(db: DbClient): Promise<void> {
  await rollupLeaderboard(db, "1h", "hour", "2 hours");
  // "1 day" = current + just-closed day only (was "2 days" → 3 calendar days of
  // raw samples re-scanned every 5 min — the heaviest of the OOM offenders).
  await rollupLeaderboard(db, "1d", "day", "1 day");
  await pruneLeaderboard(db);
}
