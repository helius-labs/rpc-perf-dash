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
import { FilterGroup } from "./FilterGroup";
import { LatencyChart } from "./LatencyChart";

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
    <div style={{ marginBottom: 16 }}>
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
      <div className="border border-line rounded-lg overflow-hidden" aria-busy="true" aria-label="Loading chart">
        <svg viewBox="0 0 1280 420" className="block w-full h-auto animate-pulse">
          {[80, 160, 240, 320].map((y) => (
            <line key={y} x1={56} x2={1264} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
          ))}
          <polyline
            points="56,300 240,260 430,285 620,210 810,250 1000,180 1190,205"
            fill="none"
            stroke="var(--border-2)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points="56,350 240,330 430,345 620,300 810,330 1000,290 1190,310"
            fill="none"
            stroke="var(--border-2)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.6}
          />
        </svg>
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
  selectedGeo,
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
  /** Score-query inputs — null geo = Overall (blend across active geos). */
  selectedGeo: GeoRegion | null;
  workerProvider?: string | undefined;
}) {
  // Both series are fetched up front so the client-side Latency/Score toggle
  // switches without a refetch / Suspense flash. The score series reads the
  // single selected method (the chart shows one method at a time).
  const method = methods[0];
  const [series, scoreSeries] = await Promise.all([
    fetchLatencySeries({ cloudPairs, methods, windowHours, connectionMode }),
    method
      ? fetchScoreSeries({ selectedGeo, windowHours, connectionMode, method, workerProvider })
      : Promise.resolve([]),
  ]);
  return (
    <LatencyChart
      series={series}
      scoreSeries={scoreSeries}
      windowHours={windowHours}
      connectionMode={connectionMode}
      filters={filters}
      showRpcFilter
      initialBenchmarked={initialBenchmarked}
      method={method}
      selectedGeo={selectedGeo}
      workerProvider={workerProvider}
    />
  );
}
