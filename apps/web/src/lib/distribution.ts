/**
 * Latency-distribution data for the Performance page's "Latency distribution"
 * metric (CDF / histogram / box).
 *
 * Reads the PRECOMPUTED `latency_histogram_*` tables (0001_initial.sql): per
 * rollup bucket, a sparse 60-bin log histogram + count + exact min, written by
 * the generator (apps/generator/src/rollup.ts). Bin counts are additive across
 * buckets, so a window read just sums the bin maps and reconstructs density,
 * CDF, and box stats in JS — ~10-50ms at any window, vs the old 2-11s raw
 * `samples` percentile_cont scan. No window cap needed.
 *
 * Win% comes from the precomputed leaderboard_agg.n_wins, region-weighted like the
 * leaderboard/overview: the Overall (geo=null) case blends per-geo win rates with
 * DEFAULT_REGION_WEIGHTS; a single selected geo collapses to that geo's rate. NOTE:
 * unlike the ranked board this has no eligibility gate, so it blends over every
 * present geo, not the eligible subset — it tracks the board's win% but isn't
 * guaranteed exactly equal.
 */
import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import {
  LATENCY_HIST,
  latencyBinLo,
  latencyBinHi,
  latencyHistogramGrainForWindow,
  leaderboardGrainForWindow,
  POOLED_INFRA,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { blendRegionScalar, DEFAULT_REGION_WEIGHTS } from "@rpcbench/shared/scoring";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import { db } from "@/lib/db";
import { colorFor } from "@/lib/providerColors";
import { type DistributionSeries } from "@/components/DistributionCharts";

export interface DistributionQuery {
  method: Method;
  connectionMode: "cold" | "warm";
  windowHours: number;
  /** null = Overall (sum across all geos). */
  geo: GeoRegion | null;
  /** Infra filter — undefined pools every cloud ('__all__'). */
  workerProvider?: string | undefined;
}

export interface DistributionResult {
  series: DistributionSeries[];
}

interface HistRow {
  provider_id: string;
  bins: Record<string, number>;
  n: number;
  min_ms: number | null;
}

/** Build a 101-point percentile array (p0..p100) from merged bin counts. q[0]
 *  is the exact min; the rest log-interpolate within the crossing bin. */
function quantilesFromBins(merged: Map<number, number>, n: number, minMs: number): number[] {
  const q = new Array<number>(101).fill(minMs || 0);
  if (n <= 0) return q;
  const bins = [...merged.entries()].sort((a, b) => a[0] - b[0]);
  let bi = 0;
  let cumBefore = 0;
  for (let p = 0; p <= 100; p++) {
    const target = (p / 100) * n;
    while (bi < bins.length && cumBefore + bins[bi]![1] < target) {
      cumBefore += bins[bi]![1];
      bi++;
    }
    if (bi >= bins.length) {
      const lastBin = bins[bins.length - 1]?.[0] ?? 1;
      q[p] = latencyBinHi(lastBin);
      continue;
    }
    const [bin, cnt] = bins[bi]!;
    const lo = latencyBinLo(bin);
    const hi = latencyBinHi(bin);
    const frac = cnt > 0 ? (target - cumBefore) / cnt : 0;
    q[p] = Math.exp(Math.log(lo) + frac * (Math.log(hi) - Math.log(lo)));
  }
  if (minMs > 0) q[0] = minMs; // exact floor (the bin only gives a range)
  return q;
}

async function fetchLatencyDistributionImpl(opts: DistributionQuery): Promise<DistributionResult> {
  const { method, connectionMode, windowHours, geo, workerProvider } = opts;
  const histTable = sql.raw("latency_histogram");
  const histGrain = latencyHistogramGrainForWindow(windowHours);
  const scope = workerProvider ?? POOLED_INFRA;
  const geoClause = geo ? sql`AND geo = ${geo}` : sql``;

  // One row per (provider, geo, bucket) for the scope — small (≤ ~providers ×
  // geos × buckets). Merge in JS.
  const rows = (await db().execute(sql`
    SELECT provider_id, bins, n, min_ms
    FROM ${histTable}
    WHERE grain = ${histGrain}
      AND worker_provider = ${scope}
      AND method = ${method}
      AND connection_mode = ${connectionMode}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${geoClause}
  `)) as unknown as HistRow[];

  // Win% from the n_wins precompute, region-weighted like the leaderboard: per-geo
  // raw win rate → region-blend (Overall) or single-geo passthrough (selected geo).
  const grain = leaderboardGrainForWindow(windowHours);
  const aggTable = sql.raw("leaderboard_agg");
  const chalTable = sql.raw("leaderboard_challenges");
  const winGeoClause = geo ? sql`AND geo = ${geo}` : sql``;
  const winRows = (await db().execute(sql`
    SELECT provider_id, geo, sum(n_wins)::int AS wins
    FROM ${aggTable}
    WHERE grain = ${grain} AND worker_provider = ${scope} AND method = ${method} AND connection_mode = ${connectionMode}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${winGeoClause}
    GROUP BY provider_id, geo
  `)) as unknown as Array<{ provider_id: string; geo: GeoRegion; wins: number }>;
  const chalRows = (await db().execute(sql`
    SELECT geo, coalesce(sum(n_challenges), 0)::int AS n
    FROM ${chalTable}
    WHERE grain = ${grain} AND worker_provider = ${scope} AND method = ${method} AND connection_mode = ${connectionMode}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${winGeoClause}
    GROUP BY geo
  `)) as unknown as Array<{ geo: GeoRegion; n: number }>;
  // Per-geo challenge denominator (shared across providers within a geo).
  const denomByGeo = new Map<GeoRegion, number>(chalRows.map((r) => [r.geo, r.n]));
  // provider -> (geo -> raw win rate), then region-blend to one 0-100 win%.
  const winRateByProviderGeo = new Map<string, Map<GeoRegion, number>>();
  for (const r of winRows) {
    const denom = denomByGeo.get(r.geo) ?? 0;
    if (denom <= 0) continue;
    let m = winRateByProviderGeo.get(r.provider_id);
    if (!m) {
      m = new Map();
      winRateByProviderGeo.set(r.provider_id, m);
    }
    m.set(r.geo, r.wins / denom);
  }
  const winPctById = new Map<string, number>();
  for (const [id, perGeo] of winRateByProviderGeo) {
    winPctById.set(id, 100 * (blendRegionScalar(perGeo, DEFAULT_REGION_WEIGHTS) ?? 0));
  }

  // Merge bin maps + count + min across (geo, bucket) per provider.
  const merged = new Map<string, { bins: Map<number, number>; n: number; min: number }>();
  for (const r of rows) {
    let m = merged.get(r.provider_id);
    if (!m) {
      m = { bins: new Map(), n: 0, min: Infinity };
      merged.set(r.provider_id, m);
    }
    m.n += r.n;
    if (r.min_ms != null) m.min = Math.min(m.min, r.min_ms);
    for (const [k, v] of Object.entries(r.bins ?? {})) {
      const bin = Number(k);
      m.bins.set(bin, (m.bins.get(bin) ?? 0) + Number(v));
    }
  }

  const nameOf = (id: string) => BENCHMARKED_PROVIDERS.find((p) => p.id === id)?.name ?? id;

  const series: DistributionSeries[] = [...merged.entries()]
    .filter(([, m]) => m.n > 0)
    .map(([id, m]) => {
      const minMs = Number.isFinite(m.min) ? m.min : 0;
      const q = quantilesFromBins(m.bins, m.n, minMs);
      const hist = [...m.bins.entries()].map(([bucket, cnt]) => ({ bucket, cnt }));
      const histMax = Math.max(1, ...hist.map((h) => h.cnt));
      return {
        id,
        name: nameOf(id),
        color: colorFor(id),
        n: m.n,
        q,
        p50: q[50]!,
        p95: q[95]!,
        min: minMs,
        p25: q[25]!,
        p75: q[75]!,
        p99: q[99]!,
        hist,
        histMax,
        winPct: winPctById.get(id) ?? 0,
      };
    })
    .sort((a, b) => a.p50 - b.p50);

  return { series };
}

// Histogram reads are tiny + cheap, but a short cache still collapses
// concurrent identical requests.
export const fetchLatencyDistribution = unstable_cache(
  fetchLatencyDistributionImpl,
  ["fetchLatencyDistribution"],
  { revalidate: 60 },
);

// Re-exported so the bin domain stays importable from one place.
export { LATENCY_HIST };
