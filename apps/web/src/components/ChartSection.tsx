/**
 * Server-streamed chart panel + its loading skeleton. The chart's data
 * (fetchLatencySeries) is awaited inside ChartPanel so it can sit behind its
 * own Suspense boundary on the home page — keyed by the chart filters, so
 * changing a filter shows ChartLoading (a pulsing skeleton) while the new
 * series streams, without blanking the filter bar.
 */

import type { ReactNode } from "react";
import type { GeoRegion, Method } from "@rpcbench/shared";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import { fetchLatencySeries, type CloudPair } from "@/lib/chartData";
import { fetchScoreSeries } from "@/lib/leaderboard";
import { binOptionsForWindow, binLabel } from "@/lib/chartBins";
import { DB_ERROR_MESSAGE } from "@/lib/db";
import { FilterGroup } from "./FilterGroup";
import { LatencyChart } from "./LatencyChart";
import { ChartSkeleton } from "./ChartSkeleton";

const BAR_CLS =
  "flex flex-col gap-3 py-3 border-y border-line mb-4 md:flex-row md:flex-wrap md:items-center md:gap-x-[22px] md:gap-y-3.5 md:py-3.5";

// Static, non-interactive placeholder pill — keeps the chart-internal controls
// (RPC / Metric / Percentile / Bin / Outliers) present in the loading bar so
// nothing disappears while new series stream in.
const PH_PILL =
  "inline-block border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] bg-transparent text-muted opacity-50";

/**
 * Suspense fallback: keep the WHOLE control bar (server filters + the chart's
 * own RPC/Metric/Percentile/Bin/Outliers controls, as inert placeholders) and
 * pulse a skeleton plot — so changing a filter never makes controls vanish.
 */
export function ChartLoading({ filters, windowHours }: { filters: ReactNode; windowHours: number }) {
  const bins = binOptionsForWindow(windowHours, "latency");
  const ph = (label: string) => (
    <span key={label} className={PH_PILL} aria-hidden="true">
      {label}
    </span>
  );
  return (
    <div className="mb-4">
      <div className={BAR_CLS}>
        {filters}
        <FilterGroup label="RPC">
          {ph("All")}
          {BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).map((p) => ph(p.name))}
        </FilterGroup>
        <FilterGroup label="Metric">
          {ph("Latency")}
          {ph("Score")}
          {ph("Distribution")}
        </FilterGroup>
        <FilterGroup label="Percentile">
          {ph("p50")}
          {ph("p95")}
        </FilterGroup>
        {bins.length > 1 && <FilterGroup label="Bin">{bins.map((m) => ph(binLabel(m)))}</FilterGroup>}
        <FilterGroup label="Outliers">{ph("shown")}</FilterGroup>
      </div>
      <ChartSkeleton />
    </div>
  );
}

/**
 * Chart-area error state: keeps the server filter bar present (so the page
 * stays interactive — changing a filter re-runs the query) and shows the
 * generic DB-unavailable badge in place of the plot. Used when the chart's
 * own data fetch throws (e.g. the DB OOMs on the heavy percentile query) so a
 * single failed query degrades the chart instead of 500-ing the whole route.
 */
export function ChartError({ filters }: { filters: ReactNode }) {
  return (
    <div className="mb-4">
      <div className={BAR_CLS}>{filters}</div>
      <div
        className="badge bad"
        style={{ display: "block", padding: 12, margin: "8px 0" }}
        role="alert"
      >
        Chart unavailable: {DB_ERROR_MESSAGE}
      </div>
    </div>
  );
}

export async function ChartPanel({
  cloudPairs,
  methods,
  windowHours,
  connectionMode,
  initialBenchmarked,
  filters,
  selectedGeos,
  workerProvider,
}: {
  cloudPairs: readonly CloudPair[];
  methods: readonly Method[];
  windowHours: number;
  connectionMode: "cold" | "warm";
  /** Initial RPC multi-select (from the `bp` URL param). Filtering is done
   *  client-side in LatencyChart so toggling needs no server round-trip; the
   *  full series is always fetched and passed unfiltered. */
  initialBenchmarked: readonly string[];
  filters: ReactNode;
  /** Score-query region subset — empty = Overall (blend across active geos). */
  selectedGeos: GeoRegion[];
  workerProvider?: string | undefined;
}) {
  // Both series are fetched up front so the client-side Latency/Score toggle
  // switches without a refetch / Suspense flash. The score series blends ALL
  // selected methods (even weight) over the selected region subset. Methods
  // are sorted so the fetchScoreSeries cache key is order-independent.
  const sortedMethods = [...new Set(methods)].sort();
  let series: Awaited<ReturnType<typeof fetchLatencySeries>>;
  let scoreSeries: Awaited<ReturnType<typeof fetchScoreSeries>>;
  try {
    [series, scoreSeries] = await Promise.all([
      fetchLatencySeries({ cloudPairs, methods, windowHours, connectionMode }),
      sortedMethods.length > 0
        ? fetchScoreSeries({ selectedGeos, windowHours, connectionMode, methods: sortedMethods, workerProvider })
        : Promise.resolve([]),
    ]);
  } catch (err) {
    // The chart fetch runs inside <Suspense> with no error boundary above it,
    // so an unhandled throw here would propagate to Next.js as a server-side
    // exception and 500 the entire page. Degrade to an inline error instead.
    console.error("[ChartPanel]", err);
    return <ChartError filters={filters} />;
  }
  return (
    <LatencyChart
      series={series}
      scoreSeries={scoreSeries}
      windowHours={windowHours}
      connectionMode={connectionMode}
      filters={filters}
      showRpcFilter
      initialBenchmarked={initialBenchmarked}
      method={methods.length === 1 ? methods[0] : undefined}
      selectedGeos={selectedGeos}
      workerProvider={workerProvider}
    />
  );
}
