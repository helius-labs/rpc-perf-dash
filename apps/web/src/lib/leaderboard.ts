/**
 * Shared leaderboard data layer. Extracted from app/page.tsx so the home page
 * and the provider deep-dive (app/provider/[id]) rank providers identically —
 * same aggregates, same eligibility gate, same scoring/blending. Keeping one
 * source of truth means the rank/score a provider shows on its own page always
 * matches its row on the leaderboard.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import {
  GEO_REGIONS,
  METHODOLOGY_VERSION,
  POOLED_INFRA,
  geoRegionOf,
  leaderboardChallengesTableForWindow,
  leaderboardFailuresTableForWindow,
  leaderboardTableForWindow,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import {
  DEFAULT_REGION_WEIGHTS,
  DEFAULT_WEIGHTS,
  blendRegionScores,
  score,
  type ScoredProvider,
} from "@rpcbench/shared/scoring";
import { db } from "@/lib/db";
import {
  buildOverallLeaderRows,
  rowToMetrics,
  scorePerGeo,
  type OverallLeaderRow,
  type RowAgg,
} from "@/components/leaderboardShared";

/**
 * Cache TTL for all server-side data fetchers. The dashboard updates on the
 * generator's 30s tick, so caching for 30s means repeat reads (within the same
 * revalidation window) render instantly without losing freshness.
 */
export const CACHE_TTL_S = 30;

/**
 * Active (worker_provider, region) pairs from recent heartbeats. Used to hide
 * empty geos — only geos with at least one heartbeating worker show up.
 */
async function fetchActiveGeosImpl(): Promise<GeoRegion[]> {
  const rows = (await db().execute(sql`
    SELECT DISTINCT worker_provider, region
    FROM worker_heartbeat
    WHERE beat_at > now() - interval '5 minutes'
  `)) as unknown as Array<{ worker_provider: string; region: string }>;
  const found = new Set<GeoRegion>();
  for (const r of rows) {
    found.add(geoRegionOf(r.worker_provider, r.region));
  }
  // Preserve canonical GEO_REGIONS ordering.
  return GEO_REGIONS.filter((g) => found.has(g));
}

export const fetchActiveGeos = unstable_cache(
  fetchActiveGeosImpl,
  ["fetchActiveGeos"],
  { revalidate: CACHE_TTL_S },
);

/** Distinct cloud-infra (worker_provider) vantages heartbeating in the last 5
 *  minutes — drives the "Infra" filter (aws / gcp / cloudflare / …). */
async function fetchActiveProvidersImpl(): Promise<string[]> {
  const rows = (await db().execute(sql`
    SELECT DISTINCT worker_provider
    FROM worker_heartbeat
    WHERE beat_at > now() - interval '5 minutes'
    ORDER BY worker_provider
  `)) as unknown as Array<{ worker_provider: string }>;
  return rows.map((r) => r.worker_provider);
}

export const fetchActiveProviders = unstable_cache(
  fetchActiveProvidersImpl,
  ["fetchActiveProviders"],
  { revalidate: CACHE_TTL_S },
);

export interface InfraGeoPair {
  worker_provider: string;
  geo: GeoRegion;
}

/** Active (worker_provider, geo) pairs from recent heartbeats — drives the
 *  context-aware filter pills (an infra is only offered in geos where it runs
 *  workers, and vice-versa). e.g. AWS/TeraSwitch have no eu-west/na-west/
 *  ap-southeast vantages, so those combos are disabled. */
async function fetchActiveInfraGeoImpl(): Promise<InfraGeoPair[]> {
  const rows = (await db().execute(sql`
    SELECT DISTINCT worker_provider, region
    FROM worker_heartbeat
    WHERE beat_at > now() - interval '5 minutes'
  `)) as unknown as Array<{ worker_provider: string; region: string }>;
  const seen = new Set<string>();
  const out: InfraGeoPair[] = [];
  for (const r of rows) {
    const geo = geoRegionOf(r.worker_provider, r.region);
    const key = `${r.worker_provider}|${geo}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ worker_provider: r.worker_provider, geo });
    }
  }
  return out;
}

export const fetchActiveInfraGeo = unstable_cache(
  fetchActiveInfraGeoImpl,
  ["fetchActiveInfraGeo"],
  { revalidate: CACHE_TTL_S },
);

/**
 * Eligibility floors, derived inline from the *selected* window so the gate
 * tracks the timeframe (1h/6h/24h/7d/30d) instead of the generator's fixed
 * 4h precompute. The quality floors (reliability / correctness / honeypot)
 * are fixed ratios and mirror the generator's POC gate in rollup.ts; the
 * sample-count floor scales with the window at the same per-hour rate as
 * that gate (50 valid samples / 4h = 12.5/hr) so confidence is comparable at
 * every window. Keep these in sync with rollup.ts:eligibilityThresholds().
 */
export function eligibilityFloors(windowHours: number) {
  const test = process.env.TEST_MODE === "1";
  const ratePerHour = test ? 3 : 12.5; // valid samples/hour
  return {
    minValid: Math.ceil(ratePerHour * windowHours),
    minReliability: test ? 0.3 : 0.8,
    minCorrectness: test ? 0.3 : 0.8,
    minHoneypotLb: test ? 0.0 : 0.95,
  };
}

export interface AggregateOpts {
  geoRegion: GeoRegion;
  windowHours: number;
  connectionMode: "cold" | "warm";
  workerProvider?: string;
  method: Method;
}

async function fetchAggregatesForGeoImpl(opts: AggregateOpts): Promise<RowAgg[]> {
  // All windows read the leaderboard precompute (leaderboard_agg_1h / _1d),
  // refreshed every 5 min by the generator's rollup tick (trailing-2h upsert).
  // This replaced the ≤24h raw-`samples` path, which scanned the
  // multi-million-row current-day partition twice per geo — and, since the
  // breakdown table's cold/warm toggle, ×2 for warm as well (12 scans/render).
  // The precompute gives exact rates (summed num/den) and exact win-counts;
  // percentiles are weight-averaged across hourly buckets, the same benign
  // approximation the >24h view always used. Measured: sigs 24h 1956ms → ~80ms.
  const floor = eligibilityFloors(opts.windowHours);
  return fetchAggregatesFromPrecompute(opts, floor);
}

/**
 * >24h leaderboard read. Sums the precomputed (geo, infra, provider, method,
 * mode, mv, time-bucket) rows over the window, weight-averaging the correct-only
 * percentiles by sample_count_valid across **time buckets only** (each row's
 * percentile already pooled regions + difficulty buckets at write time, so this
 * leaves only the benign time-averaging residual). Rates are exact ratios of
 * summed numerators/denominators; freshness is weighted by sample_count_total;
 * stddev is a weighted avg (approximate). Win-counts/challenge-counts are exact.
 * Returns the same RowAgg shape + inline eligibility as the ≤24h exact path.
 */
async function fetchAggregatesFromPrecompute(
  opts: AggregateOpts,
  floor: ReturnType<typeof eligibilityFloors>,
): Promise<RowAgg[]> {
  const aggTable = sql.raw(leaderboardTableForWindow(opts.windowHours));
  const chalTable = sql.raw(leaderboardChallengesTableForWindow(opts.windowHours));
  const failTable = sql.raw(leaderboardFailuresTableForWindow(opts.windowHours));
  const wpKey = opts.workerProvider ?? POOLED_INFRA;

  const rows = await db().execute(sql`
    WITH agg AS (
      SELECT
        provider_id,
        round(sum(latency_p50_correct::bigint * sample_count_valid)::numeric
              / NULLIF(sum(sample_count_valid) FILTER (WHERE latency_p50_correct IS NOT NULL), 0))::int AS p50_ms,
        round(sum(latency_p95_correct::bigint * sample_count_valid)::numeric
              / NULLIF(sum(sample_count_valid) FILTER (WHERE latency_p95_correct IS NOT NULL), 0))::int AS p95_ms,
        round(sum(latency_p99_correct::bigint * sample_count_valid)::numeric
              / NULLIF(sum(sample_count_valid) FILTER (WHERE latency_p99_correct IS NOT NULL), 0))::int AS p99_ms,
        (sum(latency_stddev * sample_count_valid)
              / NULLIF(sum(sample_count_valid) FILTER (WHERE latency_stddev IS NOT NULL), 0))::real AS stddev_ms,
        sum(sample_count_valid)::int  AS sample_count_valid,
        sum(sample_count_total)::int  AS sample_count_total,
        sum(sample_count_failed)::int AS sample_count_failed,
        sum(honeypot_pass_count)::int AS honeypot_pass_count,
        sum(honeypot_total)::int      AS honeypot_total,
        (sum(success_num)::real      / NULLIF(sum(sample_count_total)::real, 0))::real AS success_rate,
        (sum(correctness_num)::real  / NULLIF(sum(correctness_den)::real, 0))::real    AS correctness_rate,
        (sum(completeness_num)::real / NULLIF(sum(completeness_den)::real, 0))::real   AS completeness_rate,
        round(sum(freshness_p95_lag::bigint * sample_count_total)::numeric
              / NULLIF(sum(sample_count_total) FILTER (WHERE freshness_p95_lag IS NOT NULL), 0))::int AS freshness_p95_lag,
        sum(n_wins)::int AS n_wins
      FROM ${aggTable}
      WHERE geo = ${opts.geoRegion}
        AND worker_provider = ${wpKey}
        AND method = ${opts.method}
        AND connection_mode = ${opts.connectionMode}
        AND methodology_version = ${METHODOLOGY_VERSION}
        AND window_start > now() - make_interval(hours => ${opts.windowHours})
      GROUP BY provider_id
    ),
    chal AS (
      SELECT coalesce(sum(n_challenges), 0)::int AS n_challenges_with_winner
      FROM ${chalTable}
      WHERE geo = ${opts.geoRegion}
        AND worker_provider = ${wpKey}
        AND method = ${opts.method}
        AND connection_mode = ${opts.connectionMode}
        AND methodology_version = ${METHODOLOGY_VERSION}
        AND window_start > now() - make_interval(hours => ${opts.windowHours})
    ),
    fails AS (
      -- Per-provider failure breakdown for the SAME filter, summed across time
      -- buckets and collapsed to one JSON array per provider (desc by count).
      -- Counts come from the scf-predicate companion, so they sum to the agg's
      -- sample_count_failed → the breakdown explains the missing success %.
      SELECT provider_id,
             jsonb_agg(jsonb_build_object('category', failure_category, 'n', n) ORDER BY n DESC) AS failure_breakdown
      FROM (
        SELECT provider_id, failure_category, sum(n)::int AS n
        FROM ${failTable}
        WHERE geo = ${opts.geoRegion}
          AND worker_provider = ${wpKey}
          AND method = ${opts.method}
          AND connection_mode = ${opts.connectionMode}
          AND methodology_version = ${METHODOLOGY_VERSION}
          AND window_start > now() - make_interval(hours => ${opts.windowHours})
        GROUP BY provider_id, failure_category
      ) f
      GROUP BY provider_id
    )
    SELECT
      p.id   AS provider_id,
      a.p50_ms, a.p95_ms, a.p99_ms, a.stddev_ms,
      coalesce(a.sample_count_valid, 0)  AS sample_count_valid,
      coalesce(a.sample_count_total, 0)  AS sample_count_total,
      coalesce(a.sample_count_failed, 0) AS sample_count_failed,
      a.success_rate, a.correctness_rate, a.completeness_rate,
      a.freshness_p95_lag,
      coalesce(a.honeypot_pass_count, 0) AS honeypot_pass_count,
      coalesce(a.honeypot_total, 0)      AS honeypot_total,
      coalesce(a.n_wins, 0)              AS n_wins,
      coalesce(fa.failure_breakdown, '[]'::jsonb) AS failure_breakdown,
      (SELECT n_challenges_with_winner FROM chal) AS n_challenges_with_winner,
      (coalesce(a.sample_count_valid, 0) >= ${floor.minValid}
        AND coalesce(a.success_rate, 0)     >= ${floor.minReliability}
        AND coalesce(a.correctness_rate, 0) >= ${floor.minCorrectness}
        AND wilson_lower_bound(coalesce(a.honeypot_pass_count, 0), coalesce(a.honeypot_total, 0), 1.96)
              >= ${floor.minHoneypotLb}) AS eligible,
      CASE
        WHEN coalesce(a.sample_count_valid, 0) < ${floor.minValid}     THEN 'insufficient_samples'
        WHEN coalesce(a.success_rate, 0)     < ${floor.minReliability}  THEN 'reliability_below_threshold'
        WHEN coalesce(a.correctness_rate, 0) < ${floor.minCorrectness}  THEN 'correctness_below_threshold'
        WHEN wilson_lower_bound(coalesce(a.honeypot_pass_count, 0), coalesce(a.honeypot_total, 0), 1.96)
              < ${floor.minHoneypotLb}                                  THEN 'honeypot_pass_below_threshold'
        ELSE NULL
      END AS failing_reason
    FROM (SELECT id FROM providers WHERE benchmarked = true) p
    LEFT JOIN agg a ON a.provider_id = p.id
    LEFT JOIN fails fa ON fa.provider_id = p.id
  `);

  return rows as unknown as RowAgg[];
}

export const fetchAggregatesForGeo = unstable_cache(
  fetchAggregatesForGeoImpl,
  ["fetchAggregatesForGeo"],
  { revalidate: CACHE_TTL_S },
);

/**
 * Full Overall leaderboard, ranked — the same blend the home page shows for the
 * default view (all active geos, getTransaction, cold, 24h, default weights). The
 * provider deep-dive uses this to resolve a provider's rank + composite score +
 * blended latency/win-rate/sample stats without re-deriving the maths.
 */
export async function fetchRankedOverall(opts?: {
  windowHours?: number;
  connectionMode?: "cold" | "warm";
  method?: Method;
}): Promise<OverallLeaderRow[]> {
  const windowHours = opts?.windowHours ?? 24;
  const connectionMode = opts?.connectionMode ?? "cold";
  const method: Method = opts?.method ?? "getTransaction";

  const geos = await fetchActiveGeos();
  const targets = geos.length > 0 ? geos : GEO_REGIONS;
  const perGeo = await Promise.all(
    targets.map(async (geo) => {
      const rows = await fetchAggregatesForGeo({ geoRegion: geo, windowHours, connectionMode, method });
      const eligible = rows.filter(
        (r) => r.eligible === true && r.p95_ms !== null && r.p50_ms !== null,
      );
      return { geo, rows, eligible, scored: scorePerGeo({ eligible }, DEFAULT_WEIGHTS) };
    }),
  );

  const map = new Map<GeoRegion, ScoredProvider[]>();
  for (const o of perGeo) map.set(o.geo, o.scored);
  const blended = blendRegionScores(map, DEFAULT_REGION_WEIGHTS);
  return buildOverallLeaderRows(blended, perGeo);
}

export interface MethodLatencyRow {
  method: string;
  provider_id: string;
  connection_mode: "cold" | "warm";
  p50: number | null;
  p95: number | null;
}

/**
 * Per-(method × provider × cold/warm) p50 + p95 over the window, pooled across
 * all regions. Feeds the "By method" breakdown table — both connection modes so
 * the table's cold/warm toggle is client-side. One query.
 *
 * Reads the leaderboard precompute (leaderboard_agg_1h / _1d) instead of raw
 * `samples`: it sums the pooled-infra (`worker_provider = __all__`) rows across
 * every geo and weight-averages the correct-only percentiles by
 * sample_count_valid. Same correct-only semantics as before, ~5-min fresh, but
 * reads ~50k precomputed rows instead of seq-scanning millions of raw samples
 * (was ~2.5s at 24h, on every render).
 */
async function fetchMethodLatencyImpl(opts: { windowHours: number }): Promise<MethodLatencyRow[]> {
  const aggTable = sql.raw(leaderboardTableForWindow(opts.windowHours));
  const rows = await db().execute(sql`
    SELECT
      method,
      provider_id,
      connection_mode,
      round(sum(latency_p50_correct::bigint * sample_count_valid)::numeric
            / NULLIF(sum(sample_count_valid) FILTER (WHERE latency_p50_correct IS NOT NULL), 0))::int AS p50,
      round(sum(latency_p95_correct::bigint * sample_count_valid)::numeric
            / NULLIF(sum(sample_count_valid) FILTER (WHERE latency_p95_correct IS NOT NULL), 0))::int AS p95
    FROM ${aggTable}
    WHERE worker_provider = ${POOLED_INFRA}
      AND methodology_version = ${METHODOLOGY_VERSION}
      AND window_start > now() - make_interval(hours => ${opts.windowHours})
    GROUP BY method, provider_id, connection_mode
  `);
  return rows as unknown as MethodLatencyRow[];
}

export const fetchMethodLatency = unstable_cache(
  fetchMethodLatencyImpl,
  ["fetchMethodLatency"],
  { revalidate: CACHE_TTL_S },
);

// ---------------------------------------------------------------------------
// Score-over-time series (section 02 chart's "Score" metric).
// ---------------------------------------------------------------------------

export interface ScorePoint {
  t: Date;
  score: number;
}

export interface ScoreSeries {
  provider_id: string;
  points: ScorePoint[];
}

export interface ScoreQuery {
  /** null = Overall (blend across active geos); otherwise a single geo. */
  selectedGeo: GeoRegion | null;
  windowHours: number;
  connectionMode: "cold" | "warm";
  /** Infra pill — undefined pools every cloud (POOLED_INFRA). */
  workerProvider?: string | undefined;
  method: Method;
}

/**
 * Point-in-time overall score per provider over time. Reads the leaderboard
 * precompute (leaderboard_agg_1h / _1d) grouped by time bucket — each row is one
 * (geo, provider, bucket) aggregate — and scores EACH bucket independently with
 * the same formula the leaderboard uses (score() per geo, blendRegionScores()
 * across geos for the Overall view). Mirrors fetchLatencySeries, but the value
 * is the composite 0-100 score instead of latency.
 *
 * No eligibility gate (unlike the leaderboard): any provider with p50+p95 in a
 * bucket is scored, so lines stay continuous. Scores are relative within each
 * bucket, so sparse buckets where only one provider reported can spike to ~100.
 *
 * Grain note: leaderboard_agg is hourly (≤7d) / daily (>7d) — there is no 5-min
 * score precompute, so at ≤24h this is coarser than the latency series (5-min).
 */
async function fetchScoreSeriesImpl(opts: ScoreQuery): Promise<ScoreSeries[]> {
  const targets: GeoRegion[] = opts.selectedGeo
    ? [opts.selectedGeo]
    : (await fetchActiveGeos());
  const geos = targets.length > 0 ? targets : [...GEO_REGIONS];

  const aggTable = sql.raw(leaderboardTableForWindow(opts.windowHours));
  const chalTable = sql.raw(leaderboardChallengesTableForWindow(opts.windowHours));
  const wpKey = opts.workerProvider ?? POOLED_INFRA;
  // `geo IN (...)` as an escaped literal list. postgres.js (Neon pooler,
  // prepare:false) rejects `= ANY(${jsArray})` — the param binds as a scalar —
  // so use the repo's literal-list convention (chartData.ts pairLiteral). Geos
  // are a fixed enum, so this is safe.
  const geoLiteral = sql.raw(geos.map((g) => `'${g.replace(/'/g, "''")}'`).join(","));

  // One row per (window_start, geo, provider_id) — guaranteed by the agg PK once
  // worker_provider/method/connection_mode/methodology_version are pinned.
  const aggRows = (await db().execute(sql`
    SELECT
      r.window_start,
      r.geo,
      r.provider_id,
      r.latency_p50_correct AS p50_ms,
      r.latency_p95_correct AS p95_ms,
      r.sample_count_valid,
      (r.success_num::real     / NULLIF(r.sample_count_total::real, 0))::real AS success_rate,
      (r.correctness_num::real / NULLIF(r.correctness_den::real, 0))::real    AS correctness_rate,
      r.freshness_p95_lag,
      r.n_wins
    FROM ${aggTable} r
    JOIN providers p ON p.id = r.provider_id AND p.benchmarked = true
    WHERE r.geo IN (${geoLiteral})
      AND r.worker_provider = ${wpKey}
      AND r.method = ${opts.method}
      AND r.connection_mode = ${opts.connectionMode}
      AND r.methodology_version = ${METHODOLOGY_VERSION}
      AND r.window_start > now() - make_interval(hours => ${opts.windowHours})
      AND r.latency_p50_correct IS NOT NULL
      AND r.latency_p95_correct IS NOT NULL
  `)) as unknown as Array<{
    window_start: Date | string;
    geo: GeoRegion;
    provider_id: string;
    p50_ms: number | null;
    p95_ms: number | null;
    sample_count_valid: number;
    success_rate: number | null;
    correctness_rate: number | null;
    freshness_p95_lag: number | null;
    n_wins: number;
  }>;

  // Win-rate denominator per (window_start, geo): challenges with any winner.
  const chalRows = (await db().execute(sql`
    SELECT window_start, geo, sum(n_challenges)::int AS n_challenges
    FROM ${chalTable}
    WHERE geo IN (${geoLiteral})
      AND worker_provider = ${wpKey}
      AND method = ${opts.method}
      AND connection_mode = ${opts.connectionMode}
      AND methodology_version = ${METHODOLOGY_VERSION}
      AND window_start > now() - make_interval(hours => ${opts.windowHours})
    GROUP BY window_start, geo
  `)) as unknown as Array<{
    window_start: Date | string;
    geo: GeoRegion;
    n_challenges: number;
  }>;

  const tms = (v: Date | string): number =>
    (v instanceof Date ? v : new Date(v)).getTime();
  const chalByBucketGeo = new Map<string, number>();
  for (const c of chalRows) {
    chalByBucketGeo.set(`${tms(c.window_start)}|${c.geo}`, c.n_challenges ?? 0);
  }

  // bucketMs -> geo -> RowAgg[] (only the fields rowToMetrics reads are needed).
  const byBucket = new Map<number, Map<GeoRegion, RowAgg[]>>();
  for (const r of aggRows) {
    const ms = tms(r.window_start);
    const nChal = chalByBucketGeo.get(`${ms}|${r.geo}`) ?? 0;
    const row = {
      provider_id: r.provider_id,
      p50_ms: r.p50_ms,
      p95_ms: r.p95_ms,
      sample_count_valid: r.sample_count_valid ?? 0,
      success_rate: r.success_rate,
      correctness_rate: r.correctness_rate,
      freshness_p95_lag: r.freshness_p95_lag,
      n_wins: r.n_wins ?? 0,
      n_challenges_with_winner: nChal,
    } as RowAgg;
    let geoMap = byBucket.get(ms);
    if (!geoMap) {
      geoMap = new Map();
      byBucket.set(ms, geoMap);
    }
    const arr = geoMap.get(r.geo) ?? [];
    arr.push(row);
    geoMap.set(r.geo, arr);
  }

  // Score each bucket, then collect per-provider points across buckets.
  const byProvider = new Map<string, ScorePoint[]>();
  for (const [ms, geoMap] of byBucket) {
    const t = new Date(ms);
    let totals: ScoredProvider[];
    if (opts.selectedGeo) {
      const rows = geoMap.get(opts.selectedGeo) ?? [];
      totals = score(rows.map(rowToMetrics), DEFAULT_WEIGHTS);
    } else {
      const perRegion = new Map<GeoRegion, ScoredProvider[]>();
      for (const [geo, rows] of geoMap) {
        perRegion.set(geo, score(rows.map(rowToMetrics), DEFAULT_WEIGHTS));
      }
      totals = blendRegionScores(perRegion, DEFAULT_REGION_WEIGHTS);
    }
    for (const sp of totals) {
      const arr = byProvider.get(sp.provider_id) ?? [];
      arr.push({ t, score: sp.total });
      byProvider.set(sp.provider_id, arr);
    }
  }

  return [...byProvider.entries()].map(([provider_id, points]) => ({
    provider_id,
    points: points.sort((a, b) => a.t.getTime() - b.t.getTime()),
  }));
}

export const fetchScoreSeries = unstable_cache(
  fetchScoreSeriesImpl,
  ["fetchScoreSeries"],
  { revalidate: CACHE_TTL_S },
);
