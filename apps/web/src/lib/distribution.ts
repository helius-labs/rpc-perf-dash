/**
 * Latency-distribution data for the Performance page's "Latency distribution"
 * metric (CDF / histogram / box).
 *
 * Reads the PRECOMPUTED `latency_histogram_*` tables (migration 0019): per
 * rollup bucket, a sparse 60-bin log histogram + count + exact min, written by
 * the generator (apps/generator/src/rollup.ts). Bin counts are additive across
 * buckets, so a window read just sums the bin maps and reconstructs density,
 * CDF, and box stats in JS — ~10-50ms at any window, vs the old 2-11s raw
 * `samples` percentile_cont scan. No window cap needed.
 *
 * Win% still comes from the precomputed leaderboard_agg.n_wins (so it tracks the
 * leaderboard/overview win rate).
 */
import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import {
  LATENCY_HIST,
  latencyBinLo,
  latencyBinHi,
  latencyHistogramTableForWindow,
  leaderboardTableForWindow,
  leaderboardChallengesTableForWindow,
  POOLED_INFRA,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
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
  const histTable = sql.raw(latencyHistogramTableForWindow(windowHours));
  const scope = workerProvider ?? POOLED_INFRA;
  const geoClause = geo ? sql`AND geo = ${geo}` : sql``;

  // One row per (provider, geo, bucket) for the scope — small (≤ ~providers ×
  // geos × buckets). Merge in JS.
  const rows = (await db().execute(sql`
    SELECT provider_id, bins, n, min_ms
    FROM ${histTable}
    WHERE worker_provider = ${scope}
      AND method = ${method}
      AND connection_mode = ${connectionMode}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${geoClause}
  `)) as unknown as HistRow[];

  // Win% from the n_wins precompute (matches the leaderboard/overview).
  const aggTable = sql.raw(leaderboardTableForWindow(windowHours));
  const chalTable = sql.raw(leaderboardChallengesTableForWindow(windowHours));
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
        winPct: winDenom > 0 ? (100 * (winById.get(id) ?? 0)) / winDenom : 0,
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
