/**
 * Latency-distribution data for the Performance page's "Latency distribution"
 * metric. Reads the raw `samples` table (no precomputed histogram exists — the
 * rollups only store p50/p95/p99), so this is fetched LAZILY via
 * /api/distribution only when the metric is selected, never on normal loads.
 *
 * Per provider we compute: a 101-point percentile array (CDF + box stats) and a
 * 60-bin log-spaced histogram, in two index-backed scans (samples_dash_idx).
 * Win% is taken from the precomputed leaderboard_agg.n_wins (no extra samples
 * scan) — same source as the leaderboard/overview, so it tracks (but won't
 * byte-match) a raw per-challenge win rate.
 *
 * Cost guard: this metric is offered ONLY for ≤6h windows (the UI disables it
 * for larger windows, and the route clamps defensively). At 24h+ the raw
 * `percentile_cont` scan runs 6–11s, and `random()`-based subsampling is worse
 * (a volatile predicate defeats samples_dash_idx → a 100s+ sequential scan). At
 * ≤6h the row counts are small enough to compute the full distribution in ~1s,
 * index-backed and unbiased — so we do NOT subsample.
 */
import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import {
  leaderboardTableForWindow,
  leaderboardChallengesTableForWindow,
  POOLED_INFRA,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import { db } from "@/lib/db";
import { colorFor } from "@/lib/providerColors";
import {
  type DistributionSeries,
  HIST_L0,
  HIST_L1,
  HIST_NBINS,
} from "@/components/DistributionCharts";

// 101 evenly-spaced quantiles → integer indices for p25/p50/p75/p95/p99.
const PCTS = Array.from({ length: 101 }, (_, i) => i / 100);
const PCT_SQL = `ARRAY[${PCTS.join(",")}]::double precision[]`;

export interface DistributionQuery {
  method: Method;
  connectionMode: "cold" | "warm";
  windowHours: number;
  /** null = Overall (all active geos). */
  geo: GeoRegion | null;
  /** Infra filter — undefined pools every cloud. */
  workerProvider?: string | undefined;
}

export interface DistributionResult {
  series: DistributionSeries[];
}

interface DistRow {
  provider_id: string;
  q: number[];
  n: number;
}
interface HistRow {
  provider_id: string;
  bucket: number;
  cnt: number;
}

async function fetchLatencyDistributionImpl(opts: DistributionQuery): Promise<DistributionResult> {
  const { method, connectionMode, windowHours, geo, workerProvider } = opts;

  const geoClause = geo ? sql`AND grm.geo = ${geo}` : sql``;
  const wpClause = workerProvider ? sql`AND s.worker_provider = ${workerProvider}` : sql``;

  // Scan 1 — 101-point percentile array (CDF + box stats), correct-only.
  const distRows = (await db().execute(sql`
    SELECT s.provider_id,
      count(*)::int AS n,
      percentile_cont(${sql.raw(PCT_SQL)}) WITHIN GROUP (ORDER BY s.latency_ms) AS q
    FROM samples s
    JOIN geo_region_map grm ON grm.worker_provider = s.worker_provider AND grm.region = s.region
    WHERE s.method = ${method} AND s.connection_mode = ${connectionMode}
      AND s.correctness = 'correct' AND s.status = 'ok'
      AND s.latency_ms IS NOT NULL
      AND s.started_at > now() - make_interval(hours => ${windowHours})
      ${geoClause} ${wpClause}
    GROUP BY s.provider_id
  `)) as unknown as DistRow[];

  // Scan 2 — 60-bin log-spaced histogram (same bins as DistributionCharts).
  const histRows = (await db().execute(sql`
    SELECT provider_id, bucket, count(*)::int AS cnt
    FROM (
      SELECT s.provider_id,
        width_bucket(ln(greatest(s.latency_ms, 1)::float), ${HIST_L0}, ${HIST_L1}, ${HIST_NBINS})::int AS bucket
      FROM samples s
      JOIN geo_region_map grm ON grm.worker_provider = s.worker_provider AND grm.region = s.region
      WHERE s.method = ${method} AND s.connection_mode = ${connectionMode}
        AND s.correctness = 'correct' AND s.status = 'ok'
        AND s.latency_ms IS NOT NULL
        AND s.started_at > now() - make_interval(hours => ${windowHours})
        ${geoClause} ${wpClause}
    ) t
    GROUP BY provider_id, bucket
  `)) as unknown as HistRow[];

  // Win% from the precomputed n_wins (no samples scan). Scope matches the
  // curves: pooled '__all__' rows unless an infra filter is active.
  const aggTable = sql.raw(leaderboardTableForWindow(windowHours));
  const chalTable = sql.raw(leaderboardChallengesTableForWindow(windowHours));
  const scope = workerProvider ?? POOLED_INFRA;
  const winGeoClause = geo ? sql`AND geo = ${geo}` : sql``;

  const winRows = (await db().execute(sql`
    SELECT provider_id, sum(n_wins)::int AS wins
    FROM ${aggTable}
    WHERE worker_provider = ${scope} AND method = ${method} AND connection_mode = ${connectionMode}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${winGeoClause}
    GROUP BY provider_id
  `)) as unknown as Array<{ provider_id: string; wins: number }>;

  const chalRows = (await db().execute(sql`
    SELECT coalesce(sum(n_challenges), 0)::int AS n
    FROM ${chalTable}
    WHERE worker_provider = ${scope} AND method = ${method} AND connection_mode = ${connectionMode}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${winGeoClause}
  `)) as unknown as Array<{ n: number }>;

  const winDenom = chalRows[0]?.n ?? 0;
  const winById = new Map(winRows.map((r) => [r.provider_id, r.wins]));
  const nameOf = (id: string) => BENCHMARKED_PROVIDERS.find((p) => p.id === id)?.name ?? id;

  const series: DistributionSeries[] = distRows
    .filter((d) => Array.isArray(d.q) && d.q.length === PCTS.length)
    .map((d) => {
      const hist = histRows
        .filter((h) => h.provider_id === d.provider_id)
        .map((h) => ({ bucket: h.bucket, cnt: h.cnt }));
      const histMax = Math.max(1, ...hist.map((h) => h.cnt));
      return {
        id: d.provider_id,
        name: nameOf(d.provider_id),
        color: colorFor(d.provider_id),
        n: d.n,
        q: d.q.map((v) => Number(v)),
        p50: Number(d.q[50]),
        p95: Number(d.q[95]),
        min: Number(d.q[0]),
        p25: Number(d.q[25]),
        p75: Number(d.q[75]),
        p99: Number(d.q[99]),
        hist,
        histMax,
        winPct: winDenom > 0 ? (100 * (winById.get(d.provider_id) ?? 0)) / winDenom : 0,
      };
    })
    .sort((a, b) => a.p50 - b.p50);

  return { series };
}

// revalidate is fixed here; the window-scaled CDN/browser TTL is authoritative
// on the /api/distribution route's Cache-Control header.
export const fetchLatencyDistribution = unstable_cache(
  fetchLatencyDistributionImpl,
  ["fetchLatencyDistribution"],
  { revalidate: 60 },
);
