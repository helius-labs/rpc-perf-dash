/**
 * Time-series query for the latency chart.
 *
 * Reads the rollup tier matched to the window (rollups_5m, or the merged
 * `rollups` table at grain '1h'/'1d'). Returns one row per (provider × bucket)
 * with a sample-count-weighted p95 across the (method × bucket × cold/warm)
 * sub-keys within each window.
 *
 * Filters by an explicit list of (worker_provider, region) pairs so the chart
 * honors both the selected geo and the selected Infra pill.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { rollupSourceForWindow, type Method } from "@rpcbench/shared";
import { db } from "./db";

// Chart-local cache TTL (independent of leaderboard.ts's shared const). 120s
// keeps the entry warm across a burst; rollups refresh on a 5-min tick so this
// is well within the data grain.
const CACHE_TTL_S = 120;

export interface ChartPoint {
  t: Date;
  p50_ms: number;
  p95_ms: number;
}

export interface ChartSeries {
  provider_id: string;
  points: ChartPoint[];
}

export interface CloudPair {
  worker_provider: string;
  region: string;
}

export interface ChartQuery {
  /** (worker_provider, region) pairs to include. Empty array returns nothing. */
  cloudPairs: readonly CloudPair[];
  methods: readonly Method[];
  windowHours: number;
  /** 'cold' (default) or 'warm'. */
  connectionMode?: "cold" | "warm";
  /** If set, restrict to a single benchmarked provider (for /provider/[id]). */
  provider_id?: string;
  /**
   * Pool every vantage instead of filtering to `cloudPairs`. When true the
   * `(worker_provider, region) IN (...)` clause is dropped entirely, so the
   * query relies on the provider_id + connection_mode + method + window_start
   * index (rollups_5m_provider_chart_idx) instead of expanding a large pair
   * list into a many-branch BitmapOr. MUST be paired with `provider_id` — without
   * it the query would pool every provider across every vantage. Used by the
   * provider deep-dive (/provider/[id]), which pools all geos for one provider.
   */
  allVantages?: boolean;
}

async function fetchLatencySeriesImpl(opts: ChartQuery): Promise<ChartSeries[]> {
  if (opts.methods.length === 0) return [];
  if (!opts.allVantages && opts.cloudPairs.length === 0) return [];

  const methodsLiteral = sql.raw(
    opts.methods.map((m) => `'${m.replace(/'/g, "''")}'`).join(","),
  );
  // allVantages pools every vantage → drop the pair filter entirely (relies on
  // rollups_5m_provider_chart_idx via provider_id below). Otherwise filter to the
  // explicit (worker_provider, region) list.
  const pairFilter = opts.allVantages
    ? sql``
    : sql`AND (r.worker_provider, r.region) IN (${sql.raw(
        opts.cloudPairs
          .map((p) => `(${escapeLit(p.worker_provider)},${escapeLit(p.region)})`)
          .join(","),
      )})`;
  const providerFilter = opts.provider_id
    ? sql`AND r.provider_id = ${opts.provider_id}`
    : sql``;
  const mode = opts.connectionMode ?? "cold";

  // Tier the source rollup to the window so long views read far fewer buckets:
  // ≤6h → rollups_5m, ≤7d → rollups grain='1h', >7d → rollups grain='1d'.
  // rollupSourceForWindow returns a validated constant table name (never user
  // input, safe for sql.raw) plus the grain to filter on — null for rollups_5m,
  // which is a separate table with NO grain column. 24h reads hourly (not
  // 5-min): a 5-min all-vantage scan of the large rollups_5m table is far
  // slower than the hourly grain. The client-side re-binning in LatencyChart
  // already handles coarser input. Semantics are otherwise the same: all-samples
  // latency_p95, sample-count-weighted.
  const source = rollupSourceForWindow(opts.windowHours);
  const sourceTable = sql.raw(source.table);
  // grain filter only for the merged `rollups` table; rollups_5m has no grain.
  const grainFilter = source.grain ? sql`AND r.grain = ${source.grain}` : sql``;

  // Join the providers table so retired providers (benchmarked=false)
  // automatically disappear from the chart without needing to purge their
  // rollup rows. This is the
  // single source of truth — keeps the chart in lockstep with the
  // leaderboard, which filters the same way.
  const rows = await db().execute(sql`
    SELECT
      r.provider_id,
      r.window_start,
      (sum(r.latency_p50::bigint * r.sample_count_valid)::float
       / NULLIF(sum(r.sample_count_valid)::float, 0))::int AS p50_ms,
      (sum(r.latency_p95::bigint * r.sample_count_valid)::float
       / NULLIF(sum(r.sample_count_valid)::float, 0))::int AS p95_ms
    FROM ${sourceTable} r
    JOIN providers p ON p.id = r.provider_id AND p.benchmarked = true
    WHERE r.connection_mode = ${mode}
      ${grainFilter}
      ${pairFilter}
      AND r.method IN (${methodsLiteral})
      AND r.window_start > now() - make_interval(hours => ${opts.windowHours})
      AND r.latency_p95 IS NOT NULL
      AND r.sample_count_valid > 0
      ${providerFilter}
    GROUP BY r.provider_id, r.window_start
    ORDER BY r.provider_id, r.window_start
  `);

  const byProvider = new Map<string, ChartPoint[]>();
  for (const r of rows as unknown as Array<{
    provider_id: string;
    window_start: Date | string;
    p50_ms: number | null;
    p95_ms: number | null;
  }>) {
    if (r.p95_ms == null) continue;
    const arr = byProvider.get(r.provider_id) ?? [];
    arr.push({
      t: r.window_start instanceof Date ? r.window_start : new Date(r.window_start),
      p50_ms: r.p50_ms ?? r.p95_ms,
      p95_ms: r.p95_ms,
    });
    byProvider.set(r.provider_id, arr);
  }
  return [...byProvider.entries()].map(([provider_id, points]) => ({
    provider_id,
    points,
  }));
}

export const fetchLatencySeries = unstable_cache(
  fetchLatencySeriesImpl,
  ["fetchLatencySeries"],
  { revalidate: CACHE_TTL_S },
);

function escapeLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
