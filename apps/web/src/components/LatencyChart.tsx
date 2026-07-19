"use client";

/**
 * SVG line chart for p95 latency over time (cold or warm, per the Connection
 * filter), with hover crosshair.
 *
 * Client component — needs mousemove for the hover tooltip. The SVG
 * structure itself is the same as the prior server-rendered version;
 * only the crosshair/tooltip layer is interactive.
 */

import { memo, useEffect, useMemo, useState } from "react";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import type { GeoRegion, Method } from "@rpcbench/shared";
import type { ChartSeries } from "@/lib/chartData";
import type { ScoreSeries } from "@/lib/leaderboard";
import { colorFor } from "@/lib/providerColors";
import { apiPath } from "@/lib/basePath";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { FilterGroup } from "./FilterGroup";
import { MobileFilterDisclosure } from "./MobileFilterDisclosure";
import { ExportButtons } from "./ExportButtons";
import { toCSV } from "@/lib/exportData";
import { binOptionsForWindow, binLabel } from "@/lib/chartBins";
import {
  CdfChart,
  DensityChart,
  BoxChart,
  type DistributionSeries,
} from "./DistributionCharts";
import { ChartSkeleton } from "./ChartSkeleton";
import { SvgChartTooltip } from "./SvgChartTooltip";

const W = 1280;
const H = 420;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;

interface Props {
  series: ChartSeries[];
  /** Overall-score-over-time series. When supplied, a Latency/Score metric
   *  toggle appears and the chart can plot the 0-100 composite instead of
   *  latency. Omitted by callers that only have latency (e.g. the provider
   *  deep-dive page) — the toggle then stays hidden. */
  scoreSeries?: ScoreSeries[];
  windowHours: number;
  /** Drives the caption label (cold = TTFB incl. handshake; warm = steady-state
   *  on a kept-alive connection). The series itself is already mode-filtered
   *  upstream in fetchLatencySeries. */
  connectionMode: "cold" | "warm";
  /** Optional extra filter groups (e.g. Region / Window / Method) rendered in
   *  the same control bar as the Bin / Outliers toggles. */
  filters?: React.ReactNode;
  /** Rendered inline in the mobile Filters-bar header, beside the collapse
   *  toggle (e.g. the Connection Cold/Warm switch). Hidden on desktop. */
  mobileInlineFilter?: React.ReactNode;
  /** When true, render the RPC multi-select (show/hide benchmarked provider
   *  lines) as local client state — no server round-trip. The home page sets
   *  this; the provider deep-dive page omits it (single provider, no selector). */
  showRpcFilter?: boolean;
  /** Initial RPC selection, seeded from the `bp` URL param. Empty = show all. */
  initialBenchmarked?: readonly string[];
  /** Single method the chart is showing — enables the "Latency distribution"
   *  metric (fetched lazily from /api/distribution). Optional: callers without
   *  it (provider deep-dive) just don't get the distribution toggle. */
  method?: Method | undefined;
  /** Current geo subset (empty = Overall) — forwarded to the distribution fetch,
   *  which scopes to a single region only when exactly one is selected. */
  selectedGeos?: readonly GeoRegion[];
  /** Current infra filter — forwarded to the distribution fetch (pools clouds when omitted). */
  workerProvider?: string | undefined;
}

type Metric = "latency" | "score" | "distribution";
type DistMode = "cumulative" | "histogram" | "box";

const METRIC_LABEL: Record<Metric, string> = {
  latency: "Latency",
  score: "Score",
  distribution: "Distribution",
};

interface HoverState {
  // SVG-space cursor x within plot area
  cx: number;
  // SVG-space cursor y within plot area
  cy: number;
  // The provider whose line is closest to the cursor (smallest |cy - py|).
  // Used to dim the other lines and highlight this one in the tooltip.
  nearestProviderId: string | null;
  // For each series: nearest point and its computed (x,y)
  rows: Array<{
    provider_id: string;
    p95_ms: number;
    t: Date;
    px: number;
    py: number;
  }>;
}

// The chart reads a window-tiered source: ≤24h → rollups_5m (5-min points),
// 7d → rollups grain='1h' (hourly), 30d → rollups grain='1d' (daily). Client-side binning can
// only group points COARSER than the source — a sub-source bin (e.g. 5m on
// hourly data) is a no-op — so the offered bins are window-aware. options[0]
// is always the native source grain (selecting it does no averaging).
// Shared filter-pill classes (match the page's FilterPill).
const PILL_BASE =
  "inline-block border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] cursor-pointer transition-colors no-underline";
const pillCls = (active: boolean): string =>
  `${PILL_BASE} ${active ? "bg-fg text-bg" : "bg-transparent text-fg2 hover:text-fg hover:no-underline"}`;

// Axis/tooltip formatters. `mounted` gates Intl (locale-aware) vs a UTC fallback
// so server and first client render agree (no hydration mismatch).
function formatHourMinute(d: Date, mounted: boolean): string {
  return mounted
    ? new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(d)
    : `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
}
function formatMonthDay(d: Date, mounted: boolean): string {
  return mounted
    ? new Intl.DateTimeFormat([], { month: "2-digit", day: "2-digit" }).format(d)
    : `${(d.getUTCMonth() + 1).toString().padStart(2, "0")}/${d.getUTCDate().toString().padStart(2, "0")}`;
}
function providerName(id: string): string {
  return BENCHMARKED_PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

export function LatencyChart({
  series,
  scoreSeries,
  windowHours,
  connectionMode,
  filters,
  mobileInlineFilter,
  showRpcFilter = false,
  initialBenchmarked,
  method,
  selectedGeos = [],
  workerProvider,
}: Props) {
  // The distribution fetch is single-region scoped: pass a region only when
  // exactly one geo is selected; any other count pools across clouds.
  const distRegion: GeoRegion | null = selectedGeos.length === 1 ? selectedGeos[0]! : null;
  // Latency vs Score. The toggle only appears when a score series was supplied
  // (the provider deep-dive page passes none → latency-only, no dead toggle).
  const hasScore = scoreSeries !== undefined;
  // Multi-method preset: the latency series pools several methods, so each
  // provider's p50/p95 is a call-volume-weighted average across those methods
  // (an approximation of a true pooled percentile — see docs/methodology.md).
  // Signalled by `method` being unset while a score series exists (the
  // single-provider deep-dive has no score series and is never multi-method).
  const multiMethod = hasScore && method === undefined;

  // RPC multi-select — pure client state. Toggling show/hides already-loaded
  // provider lines without any server round-trip or Suspense flash. Empty set =
  // show all. Mirrored to the `bp` URL param (history.replaceState, no nav) so
  // the view is shareable. Only rendered when showRpcFilter is set (home page).
  const [selectedBenchmarked, setSelectedBenchmarked] = useState<Set<string>>(
    () => new Set(initialBenchmarked ?? []),
  );
  const visibleSeries = useMemo(
    () =>
      series.filter(
        (s) => selectedBenchmarked.size === 0 || selectedBenchmarked.has(s.provider_id),
      ),
    [series, selectedBenchmarked],
  );
  const visibleScoreSeries = useMemo(
    () =>
      scoreSeries?.filter(
        (s) => selectedBenchmarked.size === 0 || selectedBenchmarked.has(s.provider_id),
      ),
    [scoreSeries, selectedBenchmarked],
  );
  useEffect(() => {
    if (!showRpcFilter || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const ids = [...selectedBenchmarked];
    if (ids.length === 0) url.searchParams.delete("bp");
    else url.searchParams.set("bp", ids.join(","));
    window.history.replaceState(window.history.state, "", url);
  }, [selectedBenchmarked, showRpcFilter]);
  // Persist the RPC line selection for the session (alongside the shareable `bp`
  // param) so a method/region/window switch — which remounts this chart via the
  // Suspense key — keeps the same lines instead of snapping back to "show all".
  const persistRpc = (next: Set<string>) => {
    try {
      if (next.size === 0) window.sessionStorage.removeItem("perf.rpc");
      else window.sessionStorage.setItem("perf.rpc", [...next].join(","));
    } catch {
      /* ignore */
    }
  };

  const [metric, setMetric] = useState<Metric>("latency");
  const isScore = hasScore && metric === "score";
  // "Latency distribution" — CDF / histogram / box, offered when a single
  // method is in context. Fetched lazily from /api/distribution only while this
  // metric is selected (reads the cheap precomputed histogram tables — fast at
  // any window); the three views render from that one dataset (sub-mode switch =
  // pure client re-render, no refetch).
  const canDistribution = hasScore && method != null;
  const isDist = canDistribution && metric === "distribution";
  const unit = isScore ? "" : "ms";

  const [distMode, setDistMode] = useState<DistMode>("cumulative");
  const [distData, setDistData] = useState<{ series: DistributionSeries[] } | null>(null);
  const [distLoading, setDistLoading] = useState(false);
  const [distError, setDistError] = useState<string | null>(null);

  // Persist the chosen metric + distribution sub-mode for the session so a
  // method/region/window switch (which remounts this chart via the Suspense
  // key) keeps the same view instead of snapping back to Latency. Restored on
  // mount (after hydration, so no SSR mismatch); written on each user choice.
  useEffect(() => {
    try {
      const m = window.sessionStorage.getItem("perf.chartMetric");
      if (m === "score" || m === "distribution" || m === "latency") setMetric(m);
      const d = window.sessionStorage.getItem("perf.distMode");
      if (d === "cumulative" || d === "histogram" || d === "box") setDistMode(d);
      const pc = window.sessionStorage.getItem("perf.percentile");
      if (pc === "p50" || pc === "p95") setPercentile(pc);
      const bn = window.sessionStorage.getItem("perf.binMinutes");
      if (bn != null && bn !== "" && Number.isFinite(Number(bn))) setBinMinutes(Number(bn));
      const ho = window.sessionStorage.getItem("perf.hideOutliers");
      if (ho === "true" || ho === "false") setHideOutliers(ho === "true");
      // RPC line selection — a shared `?bp=` link (initialBenchmarked) wins; only
      // fall back to the session-persisted set when no bp was provided.
      if (!(initialBenchmarked && initialBenchmarked.length > 0)) {
        const rpc = window.sessionStorage.getItem("perf.rpc");
        if (rpc) setSelectedBenchmarked(new Set(rpc.split(",").filter(Boolean)));
      }
    } catch {
      /* sessionStorage unavailable — fall back to defaults */
    }
  }, []);
  const chooseMetric = (m: Metric) => {
    setMetric(m);
    try {
      window.sessionStorage.setItem("perf.chartMetric", m);
    } catch {
      /* ignore */
    }
  };
  const chooseDistMode = (d: DistMode) => {
    setDistMode(d);
    try {
      window.sessionStorage.setItem("perf.distMode", d);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (!isDist || !method) return;
    const ctrl = new AbortController();
    setDistLoading(true);
    setDistError(null);
    const qs = new URLSearchParams({ method, mode: connectionMode, hours: String(windowHours) });
    if (distRegion) qs.set("region", distRegion);
    if (workerProvider) qs.set("wp", workerProvider);
    fetch(apiPath(`/api/distribution?${qs.toString()}`), { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { series: DistributionSeries[] }) => {
        setDistData(d);
        setDistLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name === "AbortError") return;
        setDistError((e as Error)?.message ?? "failed to load distribution");
        setDistLoading(false);
      });
    return () => ctrl.abort();
  }, [isDist, method, connectionMode, windowHours, distRegion, workerProvider]);
  // Compact mode shrinks the chart for mobile viewports — smaller height,
  // fewer x-axis ticks, in-SVG legend moved below the SVG. Tap-to-pin replaces
  // hover-crosshair on touch devices.
  const compact = useMediaQuery("(max-width: 767px)");
  const touch = useMediaQuery("(hover: none)");

  // Percentile toggle (chart filter). The pipeline below carries one numeric
  // `p95_ms` field (a historical name) regardless of what it holds — we feed it
  // the selected percentile, or the composite 0-100 score in score mode, so
  // nothing downstream has to branch.
  const [percentile, setPercentile] = useState<"p50" | "p95">("p95");

  // Normalize Date — Next.js may hand us strings across the SC→CC boundary in
  // some serialization paths.
  const sourceSeries = useMemo(
    () =>
      isScore
        ? (visibleScoreSeries ?? []).map((s) => ({
            provider_id: s.provider_id,
            points: s.points.map((p) => ({
              t: p.t instanceof Date ? p.t : new Date(p.t),
              p95_ms: p.score,
            })),
          }))
        : visibleSeries.map((s) => ({
            provider_id: s.provider_id,
            points: s.points.map((p) => ({
              t: p.t instanceof Date ? p.t : new Date(p.t),
              p95_ms: percentile === "p50" ? p.p50_ms : p.p95_ms,
            })),
          })),
    [visibleSeries, visibleScoreSeries, isScore, percentile],
  );

  // Client-side binning. Source granularity is window-tiered (5m / 1h / 1d);
  // we group consecutive points into wider buckets here. options[0] is the
  // native source grain. Approximation: averaging p95 values is not a true p95
  // of the underlying raw samples, but it's the right trade-off for "purely
  // client-side" — a true p95 would need a server round-trip with raw samples.
  const binOptions = useMemo(
    () => binOptionsForWindow(windowHours, isScore ? "score" : "latency"),
    [windowHours, isScore],
  );
  const sourceGrainMin = binOptions[0];
  const [binMinutes, setBinMinutes] = useState<number>(5);
  // Fall back to the native grain if the selected bin isn't valid for the
  // current window (e.g. user switched from 24h's 15m to 7d, where 15m is gone).
  const effectiveBin = binOptions.includes(binMinutes) ? binMinutes : sourceGrainMin;
  const binned = useMemo(() => {
    if (effectiveBin <= sourceGrainMin) return sourceSeries;
    const binMs = effectiveBin * 60_000;
    return sourceSeries.map((s) => {
      const buckets = new Map<number, { sum: number; n: number }>();
      for (const p of s.points) {
        const key = Math.floor(p.t.getTime() / binMs) * binMs;
        const b = buckets.get(key) ?? { sum: 0, n: 0 };
        b.sum += p.p95_ms;
        b.n += 1;
        buckets.set(key, b);
      }
      const points = [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([key, { sum, n }]) => ({
          t: new Date(key),
          p95_ms: Math.round(sum / n),
        }));
      return { provider_id: s.provider_id, points };
    });
  }, [sourceSeries, effectiveBin, sourceGrainMin]);

  // Outlier filter (toggle). Per-series IQR rule: drop points whose p95 is
  // > Q3 + 1.5 * IQR. Standard boxplot definition of an outlier. Each series
  // is filtered independently because providers have different baselines —
  // a "spike" for Helius isn't the same value as one for Alchemy. Below ~6
  // points the IQR isn't meaningful, so we skip filtering on tiny series.
  const [hideOutliers, setHideOutliers] = useState(true);
  const normalized = useMemo(() => {
    if (!hideOutliers) return binned;
    return binned.map((s) => {
      if (s.points.length < 6) return s;
      const sorted = [...s.points].map((p) => p.p95_ms).sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)]!;
      const q3 = sorted[Math.floor(sorted.length * 0.75)]!;
      const iqr = q3 - q1;
      if (iqr <= 0) return s;
      const upper = q3 + 1.5 * iqr;
      return {
        provider_id: s.provider_id,
        points: s.points.filter((p) => p.p95_ms <= upper),
      };
    });
  }, [binned, hideOutliers]);

  const all = normalized.flatMap((s) => s.points);
  const droppedCount = hideOutliers
    ? binned.flatMap((s) => s.points).length - all.length
    : 0;

  // We render once on the server (UTC, since Vercel functions default to UTC)
  // and then re-render once `mounted` flips to true on the client. After mount,
  // time labels use the user's local timezone via Intl. Without this flag the
  // server-rendered HTML matches the initial client render and React doesn't
  // schedule the re-render, so labels stay UTC.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Distribution series filtered by the RPC multi-select (same client set as
  // the latency/score lines), ordered by p50 from the fetch.
  const distSeries = useMemo(
    () =>
      (distData?.series ?? []).filter(
        (s) => selectedBenchmarked.size === 0 || selectedBenchmarked.has(s.id),
      ),
    [distData, selectedBenchmarked],
  );

  // Export (CSV/JSON) control, shape depends on the active metric. Hoisted so it
  // renders once as a value: on desktop at the end of the bar (in place), on
  // mobile in the Filters-bar header beside the Connection toggle.
  const exportButtons = isDist ? (
    <ExportButtons
      filename={`rpc-latency-distribution-${windowHours}h`}
      buildCsv={() =>
        toCSV(
          ["provider", "p50_ms", "p95_ms", "p99_ms", "min_ms", "n", "win_pct"],
          distSeries.map((s) => [
            s.name,
            Math.round(s.p50),
            Math.round(s.p95),
            Math.round(s.p99),
            Math.round(s.min),
            s.n,
            s.winPct.toFixed(1),
          ]),
        )
      }
      buildJson={() => ({
        metric: "latency-distribution",
        windowHours,
        method,
        series: distSeries.map((s) => ({
          provider_id: s.id,
          provider: s.name,
          n: s.n,
          percentiles: s.q,
          p50: s.p50,
          p95: s.p95,
          p99: s.p99,
          min: s.min,
          winPct: s.winPct,
        })),
      })}
    />
  ) : isScore ? (
    <ExportButtons
      filename={`rpc-score-${windowHours}h`}
      buildCsv={() =>
        toCSV(
          ["time", "provider", "score"],
          (visibleScoreSeries ?? []).flatMap((s) =>
            s.points.map((p) => [
              new Date(p.t).toISOString(),
              BENCHMARKED_PROVIDERS.find((bp) => bp.id === s.provider_id)?.name ?? s.provider_id,
              p.score.toFixed(2),
            ]),
          ),
        )
      }
      buildJson={() => ({
        metric: "score",
        windowHours,
        series: (visibleScoreSeries ?? []).map((s) => ({
          provider_id: s.provider_id,
          provider: BENCHMARKED_PROVIDERS.find((bp) => bp.id === s.provider_id)?.name ?? s.provider_id,
          points: s.points.map((p) => ({ t: new Date(p.t).toISOString(), score: p.score })),
        })),
      })}
    />
  ) : (
    <ExportButtons
      filename={`rpc-latency-${windowHours}h`}
      buildCsv={() =>
        toCSV(
          ["time", "provider", "p50_ms", "p95_ms"],
          visibleSeries.flatMap((s) =>
            s.points.map((p) => [
              new Date(p.t).toISOString(),
              BENCHMARKED_PROVIDERS.find((bp) => bp.id === s.provider_id)?.name ?? s.provider_id,
              p.p50_ms,
              p.p95_ms,
            ]),
          ),
        )
      }
      buildJson={() => ({
        percentile,
        windowHours,
        series: visibleSeries.map((s) => ({
          provider_id: s.provider_id,
          provider: BENCHMARKED_PROVIDERS.find((bp) => bp.id === s.provider_id)?.name ?? s.provider_id,
          points: s.points.map((p) => ({
            t: new Date(p.t).toISOString(),
            p50_ms: p.p50_ms,
            p95_ms: p.p95_ms,
          })),
        })),
      })}
    />
  );

  // Control bar (filters + Percentile / Bin / Outliers). Hoisted so it renders
  // in both the chart and the empty state — when there are no samples the
  // filters must stay so the user can change region/window/method.
  const controlBar = (
    <div className="flex flex-col py-3 border-y border-line mb-4 md:flex-row md:flex-wrap md:items-center md:gap-x-[22px] md:gap-y-3.5 md:py-3.5">
      <MobileFilterDisclosure
        inline={
          <>
            {mobileInlineFilter}
            {exportButtons}
          </>
        }
      >
      {filters}
      {/* Primary (data) filters above; chart-display toggles below. The labelled
          separator only shows on mobile — desktop keeps one unified wrapping
          row (this div is display:none there, so it never breaks the flex row). */}
      <div className="md:hidden flex items-center gap-2.5 w-full pt-0.5" aria-hidden="true">
        <span className="font-geistmono text-[9.5px] uppercase tracking-[0.14em] text-muted shrink-0">
          Chart display
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {showRpcFilter && (
        <FilterGroup label="RPC">
          {/* Multi-select: click to toggle a provider's line; empty = show all. */}
          <button
            type="button"
            onClick={() => {
              const n = new Set<string>();
              persistRpc(n);
              setSelectedBenchmarked(n);
            }}
            className={pillCls(selectedBenchmarked.size === 0)}
          >
            All
          </button>
          {BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() =>
                setSelectedBenchmarked((prev) => {
                  const next = new Set(prev);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  persistRpc(next);
                  return next;
                })
              }
              className={pillCls(selectedBenchmarked.has(p.id))}
            >
              {p.name}
            </button>
          ))}
        </FilterGroup>
      )}
      {hasScore && (
        <FilterGroup label="Metric">
          {(canDistribution
            ? (["latency", "score", "distribution"] as const)
            : (["latency", "score"] as const)
          ).map((m) => (
            <button key={m} type="button" onClick={() => chooseMetric(m)} className={pillCls(metric === m)}>
              {METRIC_LABEL[m]}
            </button>
          ))}
        </FilterGroup>
      )}
      {isDist && (
        <FilterGroup label="View">
          {(["cumulative", "histogram", "box"] as const).map((v) => (
            <button key={v} type="button" onClick={() => chooseDistMode(v)} className={pillCls(distMode === v)}>
              {v === "cumulative" ? "Cumulative" : v === "histogram" ? "Histogram" : "Box"}
            </button>
          ))}
        </FilterGroup>
      )}
      {!isScore && !isDist && (
        <FilterGroup label="Percentile">
          {(["p50", "p95"] as const).map((pp) => (
            <button
              key={pp}
              type="button"
              onClick={() => {
                setPercentile(pp);
                try {
                  window.sessionStorage.setItem("perf.percentile", pp);
                } catch {
                  /* ignore */
                }
              }}
              className={pillCls(percentile === pp)}
            >
              {pp}
            </button>
          ))}
        </FilterGroup>
      )}
      {!isDist && binOptions.length > 1 && (
        <FilterGroup label="Bin">
          {binOptions.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setBinMinutes(m);
                try {
                  window.sessionStorage.setItem("perf.binMinutes", String(m));
                } catch {
                  /* ignore */
                }
              }}
              className={pillCls(m === effectiveBin)}
            >
              {binLabel(m)}
            </button>
          ))}
        </FilterGroup>
      )}
      {!isDist && (
        <FilterGroup label="Outliers">
          <button
            type="button"
            onClick={() =>
              setHideOutliers((v) => {
                const nv = !v;
                try {
                  window.sessionStorage.setItem("perf.hideOutliers", String(nv));
                } catch {
                  /* ignore */
                }
                return nv;
              })
            }
            className={pillCls(hideOutliers)}
            title="Drop points above Q3 + 1.5·IQR per series. Hides isolated spikes while keeping sustained degradation visible."
          >
            {hideOutliers ? "hidden" : "shown"}
          </button>
        </FilterGroup>
      )}
      {/* Export lives in the mobile header (beside Connection); on desktop it
          renders here at the end of the bar. `md:contents` keeps it a direct
          flex item on desktop. */}
      <div className="max-md:hidden md:contents">{exportButtons}</div>
      </MobileFilterDisclosure>
    </div>
  );

  if (isDist) {
    const emptyCls =
      "border border-line rounded-lg flex items-center justify-center text-[13px] text-muted";
    const caption =
      distMode === "cumulative"
        ? "cumulative distribution — % of requests at or below x ms"
        : distMode === "histogram"
          ? "latency density — log-x histogram, normalized per provider"
          : "p25–p75 box · p50 line · whisker → p95 · dot p99 · tick = min";
    return (
      <div style={{ marginBottom: 16 }}>
        {controlBar}
        {distLoading && !distData ? (
          <ChartSkeleton />
        ) : distError ? (
          <div className={emptyCls} style={{ height: H }}>
            Couldn’t load distribution: {distError}
          </div>
        ) : distSeries.length === 0 ? (
          <div className={emptyCls} style={{ height: H }}>
            No samples in the last {windowHours}h.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2.5 font-geistmono text-[11px] leading-tight">
              {distSeries.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block w-2 h-2 rounded-[2px]" style={{ background: s.color }} />
                  <span className="text-fg2">{s.name}</span>
                  <span className="text-muted">
                    p50 {Math.round(s.p50)} · p95 {Math.round(s.p95)}ms · win {Math.round(s.winPct)}%
                  </span>
                </span>
              ))}
            </div>
            <div className="border border-line rounded-lg overflow-hidden p-2">
              {distMode === "cumulative" && <CdfChart series={distSeries} />}
              {distMode === "histogram" && <DensityChart series={distSeries} />}
              {distMode === "box" && <BoxChart series={distSeries} />}
            </div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
              {caption}, {connectionMode}, correct-only, last {windowHours}h. Win % is consensus wins from the
              leaderboard precompute (tracks, but won’t byte-match, a raw per-request win rate).
            </div>
          </>
        )}
      </div>
    );
  }

  if (all.length === 0) {
    return (
      <div style={{ marginBottom: 16 }}>
        {controlBar}
        <div
          className="border border-line rounded-lg flex items-center justify-center text-[13px] text-muted"
          style={{ height: H }}
        >
          No samples in the last {windowHours}h. Run{" "}
          <code className="mx-1 text-fg2">pnpm benchmark</code> to populate.
        </div>
      </div>
    );
  }

  const tzShort = mounted ? shortTzName() : "UTC";

  return (
    <div style={{ marginBottom: 16 }}>
      {controlBar}
      {(effectiveBin > sourceGrainMin || (hideOutliers && droppedCount > 0)) && (
        <div className="font-geistmono text-[10px] text-muted tracking-[0.02em] flex flex-wrap gap-x-4 gap-y-1 -mt-1.5 mb-3.5">
          {effectiveBin > sourceGrainMin && (
            <span>averaged from {binLabel(sourceGrainMin)} source · approximate {isScore ? "score" : percentile}</span>
          )}
          {hideOutliers && droppedCount > 0 && (
            <span>
              {droppedCount} point{droppedCount === 1 ? "" : "s"} hidden
            </span>
          )}
        </div>
      )}
      <LatencyChartCanvas
        normalized={normalized}
        windowHours={windowHours}
        isScore={isScore}
        unit={unit}
        compact={compact}
        touch={touch}
        mounted={mounted}
        tzShort={tzShort}
      />
      <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
        {isScore ? (
          <>
            overall score (0–100), {connectionMode}, point-in-time per bucket. Each point is scored on
            that bucket alone (no eligibility gate), so sparse buckets where one provider reported
            can read ~100. Times shown in <span suppressHydrationWarning>{tzShort}</span>. For the
            gated, window-aggregated number see the leaderboard.{" "}
            {touch ? "Tap the chart to pin values." : "Hover the chart for exact values."}
          </>
        ) : (
          <>
            {percentile} {connectionMode} latency, sample-weighted across buckets
            {multiMethod ? " and across the preset's methods (by call volume)" : ""} per provider. Times shown in{" "}
            <span suppressHydrationWarning>{tzShort}</span>. Approximation; for exact
            per-method percentiles see the leaderboard. {touch ? "Tap the chart to pin values." : "Hover the chart for exact values."}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The chart's SVG subtree, split out and memoized. Hover state lives HERE, not
 * in the parent LatencyChart — so a mousemove only re-renders this subtree,
 * never the parent's control bar or its heavy CSV/JSON export closures. Within
 * the subtree, the O(n) geometry (scales, ticks) and the polyline-point strings
 * are memoized, so a hover re-render only touches the cheap crosshair/tooltip
 * overlay and per-line opacity attributes. Only mounts when there's data, so
 * the geometry below never sees an empty series.
 */
const LatencyChartCanvas = memo(function LatencyChartCanvas({
  normalized,
  windowHours,
  isScore,
  unit,
  compact,
  touch,
  mounted,
  tzShort,
}: {
  normalized: { provider_id: string; points: { t: Date; p95_ms: number }[] }[];
  windowHours: number;
  isScore: boolean;
  unit: string;
  compact: boolean;
  touch: boolean;
  mounted: boolean;
  tzShort: string;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const PLOT_W = W - PAD_L - PAD_R;
  const PLOT_H = H - PAD_T - PAD_B;

  const geom = useMemo(() => {
    const all = normalized.flatMap((s) => s.points);
    const tMin = Math.min(...all.map((p) => p.t.getTime()));
    const tMax = Math.max(...all.map((p) => p.t.getTime()));
    const yMaxRaw = Math.max(...all.map((p) => p.p95_ms));
    // Score has a fixed 0-100 domain; latency scales to the data (rounded up).
    const yMax = isScore ? 100 : Math.max(100, Math.ceil((yMaxRaw * 1.2) / 100) * 100);
    const yMin = 0;
    const x = (ts: number) => PAD_L + ((ts - tMin) / Math.max(1, tMax - tMin)) * PLOT_W;
    const y = (ms: number) => PAD_T + (1 - (ms - yMin) / (yMax - yMin)) * PLOT_H;
    const yMajorStep = isScore ? 20 : yMax <= 500 ? 100 : yMax <= 2000 ? 250 : 500;
    const yTicks: number[] = [];
    for (let v = 0; v <= yMax; v += yMajorStep) yTicks.push(v);
    const xTickHours = Math.max(1, Math.round(windowHours / (compact ? 3 : 6)));
    const xTicks: Date[] = [];
    const startHour = new Date(tMin);
    startHour.setMinutes(0, 0, 0);
    for (
      let d = new Date(startHour);
      d.getTime() <= tMax;
      d.setHours(d.getHours() + xTickHours)
    ) {
      if (d.getTime() >= tMin - 1) xTicks.push(new Date(d));
    }
    return { tMin, tMax, x, y, yTicks, xTicks };
  }, [normalized, isScore, compact, windowHours, PLOT_W, PLOT_H]);
  const { tMin, tMax, x, y, yTicks, xTicks } = geom;

  // Polyline point strings — the O(total points) work. Memoized so a hover
  // re-render (which changes neither normalized nor the scales) reuses them and
  // only re-applies opacity / stroke-width.
  const pointStrings = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of normalized) {
      m.set(
        s.provider_id,
        s.points.map((p) => `${x(p.t.getTime()).toFixed(1)},${y(p.p95_ms).toFixed(1)}`).join(" "),
      );
    }
    return m;
  }, [normalized, x, y]);

  // Time-of-day formatter. Pre-mount = UTC (matches Vercel server). Post-mount
  // = browser-local. `mounted`/`tzShort` are owned by the parent (it also needs
  // tzShort for the caption) and passed down.
  const fmtHM = (d: Date) => formatHourMinute(d, mounted);
  const fmtMD = (d: Date) => formatMonthDay(d, mounted);
  const fmtVal = (v: number) => (isScore ? v.toFixed(1) : `${Math.round(v)}ms`);

  // Shared "compute hover state from svg-space (sx, sy)" — used by both mouse
  // move (desktop) and touch pin (mobile).
  const computeHover = (sx: number, sy: number): HoverState | null => {
    if (sx < PAD_L || sx > W - PAD_R) return null;
    const cursorTs = tMin + ((sx - PAD_L) / PLOT_W) * Math.max(1, tMax - tMin);
    const rows: HoverState["rows"] = [];
    for (const s of normalized) {
      const first = s.points[0];
      if (!first) continue;
      let best = first;
      let bestDt = Math.abs(best.t.getTime() - cursorTs);
      for (const p of s.points) {
        const dt = Math.abs(p.t.getTime() - cursorTs);
        if (dt < bestDt) {
          best = p;
          bestDt = dt;
        }
      }
      rows.push({
        provider_id: s.provider_id,
        p95_ms: best.p95_ms,
        t: best.t,
        px: x(best.t.getTime()),
        py: y(best.p95_ms),
      });
    }
    rows.sort((a, b) => (isScore ? b.p95_ms - a.p95_ms : a.p95_ms - b.p95_ms));
    let nearestProviderId: string | null = null;
    let nearestDy = Infinity;
    for (const r of rows) {
      const dy = Math.abs(r.py - sy);
      if (dy < nearestDy) {
        nearestDy = dy;
        nearestProviderId = r.provider_id;
      }
    }
    return { cx: sx, cy: sy, nearestProviderId, rows };
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    setHover(computeHover(sx, sy));
  };

  const onTouch = (e: React.TouchEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const t = e.touches[0] ?? e.changedTouches[0];
    if (!t) return;
    const sx = ((t.clientX - rect.left) / rect.width) * W;
    const sy = ((t.clientY - rect.top) / rect.height) * H;
    setHover(computeHover(sx, sy));
  };

  // Tooltip placement: prefer right of cursor, flip left near right edge
  const tipW = 200;
  const tipH = hover ? 24 + hover.rows.length * 16 : 0;
  const tipX = hover
    ? hover.cx + tipW + 12 < W - PAD_R
      ? hover.cx + 12
      : hover.cx - tipW - 12
    : 0;
  const tipY = hover ? Math.min(PAD_T + 8, H - PAD_B - tipH - 8) : 0;
  const tipTime = hover && hover.rows.length > 0 ? hover.rows[0]!.t : null;

  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{
          background: "#0f0f0f",
          border: "1px solid #222",
          display: "block",
          width: "100%",
          height: "auto",
        }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        // Touch: tap or drag to pin the crosshair. We don't clear on touchend
        // so the pinned values stick until the next tap or until the user taps
        // outside the plot area (handled by computeHover returning null).
        onTouchStart={touch ? onTouch : undefined}
        onTouchMove={touch ? onTouch : undefined}
      >
        {/* Y grid + labels */}
        {yTicks.map((v) => (
          <g key={`y-${v}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="#222" strokeWidth={1} />
            <text
              x={PAD_L - 8}
              y={y(v) + 4}
              fill="#888"
              fontSize={11}
              textAnchor="end"
              fontFamily="system-ui, sans-serif"
            >
              {v}{unit}
            </text>
          </g>
        ))}

        {/* X axis ticks */}
        {xTicks.map((d) => {
          const label = fmtHM(d);
          return (
            <g key={`x-${d.getTime()}`}>
              <line
                x1={x(d.getTime())}
                x2={x(d.getTime())}
                y1={H - PAD_B}
                y2={H - PAD_B + 4}
                stroke="#444"
                strokeWidth={1}
              />
              <text
                x={x(d.getTime())}
                y={H - PAD_B + 16}
                fill="#888"
                fontSize={11}
                textAnchor="middle"
                fontFamily="system-ui, sans-serif"
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* Plot border */}
        <rect
          x={PAD_L}
          y={PAD_T}
          width={PLOT_W}
          height={PLOT_H}
          fill="none"
          stroke="#333"
          strokeWidth={1}
        />

        {/* Series polylines. When hovering, the line closest to the cursor
            stays bright + slightly thicker; the others dim back so the
            highlighted line stands out without losing the context of where
            the others are. */}
        {normalized.map((s) => {
          const pts = pointStrings.get(s.provider_id) ?? "";
          const isNearest = hover && hover.nearestProviderId === s.provider_id;
          const isDimmed = hover && hover.nearestProviderId !== null && !isNearest;
          return (
            <polyline
              key={s.provider_id}
              points={pts}
              fill="none"
              stroke={colorFor(s.provider_id)}
              strokeWidth={isNearest ? 2.25 : 1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={isDimmed ? 0.18 : 1}
              style={{ transition: "opacity 80ms, stroke-width 80ms" }}
            />
          );
        })}

        {/* Hover crosshair + dots */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={hover.cx}
              x2={hover.cx}
              y1={PAD_T}
              y2={H - PAD_B}
              stroke="#444"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {hover.rows.map((r) => {
              const isNearest = hover.nearestProviderId === r.provider_id;
              const isDimmed = hover.nearestProviderId !== null && !isNearest;
              return (
                <circle
                  key={r.provider_id}
                  cx={r.px}
                  cy={r.py}
                  r={isNearest ? 4.5 : 3.5}
                  fill="#0f0f0f"
                  stroke={colorFor(r.provider_id)}
                  strokeWidth={isNearest ? 2.5 : 2}
                  opacity={isDimmed ? 0.3 : 1}
                />
              );
            })}
          </g>
        )}

        {/* In-SVG legend — desktop only. On compact (mobile) viewports the
            legend is rendered as a static row of color swatches below the SVG
            (see after </svg>) so it doesn't overlap the small plot. */}
        {!compact && !hover && (
          <g transform={`translate(${W - PAD_R - 140}, ${PAD_T + 8})`}>
            <rect
              x={0}
              y={0}
              width={140}
              height={normalized.length * 16 + 8}
              fill="#1a1a1a"
              stroke="#333"
              strokeWidth={1}
              rx={3}
            />
            {normalized.map((s, i) => (
              <g key={s.provider_id} transform={`translate(8, ${12 + i * 16})`}>
                <line
                  x1={0}
                  x2={16}
                  y1={0}
                  y2={0}
                  stroke={colorFor(s.provider_id)}
                  strokeWidth={2}
                />
                <text x={22} y={4} fill="#ddd" fontSize={11} fontFamily="system-ui, sans-serif">
                  {providerName(s.provider_id)}
                </text>
              </g>
            ))}
          </g>
        )}

        {/* In-SVG hover tooltip — desktop only. On compact viewports, the
            pinned values are rendered in a static panel below the SVG so
            they don't crowd the small plot area. */}
        {!compact && hover && tipTime && (
          <SvgChartTooltip
            x={tipX}
            y={tipY}
            header={`${fmtMD(tipTime)} ${fmtHM(tipTime)}${mounted ? ` ${tzShort}` : ""}`}
            rows={hover.rows.map((r) => ({
              key: r.provider_id,
              label: providerName(r.provider_id),
              value: fmtVal(r.p95_ms),
              color: colorFor(r.provider_id),
              emphasized: hover.nearestProviderId === r.provider_id,
              dimmed: hover.nearestProviderId !== r.provider_id,
            }))}
          />
        )}
      </svg>
      {/* Compact (mobile) extras: pinned-values panel + static color legend
          rendered below the SVG instead of inside it. */}
      {compact && hover && tipTime && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <div style={{ color: "#aaa", marginBottom: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            {fmtMD(tipTime)} {fmtHM(tipTime)}{mounted ? ` ${tzShort}` : ""}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", columnGap: 8, rowGap: 2 }}>
            {hover.rows.map((r) => {
              const isNearest = hover.nearestProviderId === r.provider_id;
              return (
                <div key={r.provider_id} style={{ display: "contents", color: isNearest ? "#fff" : "#999", fontWeight: isNearest ? 600 : 400 }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: colorFor(r.provider_id),
                      borderRadius: 2,
                      alignSelf: "center",
                    }}
                  />
                  <span style={{ fontSize: 11 }}>{providerName(r.provider_id)}</span>
                  <span style={{ fontSize: 11, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                    {fmtVal(r.p95_ms)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {compact && (
        <div
          style={{
            marginTop: 6,
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 12px",
            fontSize: 11,
            color: "#aaa",
          }}
          aria-label="chart legend"
        >
          {normalized.map((s) => (
            <span key={s.provider_id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 2,
                  background: colorFor(s.provider_id),
                  borderRadius: 1,
                }}
              />
              {providerName(s.provider_id)}
            </span>
          ))}
        </div>
      )}
    </>
  );
});


function shortTzName(): string {
  // Best-effort short timezone label for chart annotations. Falls back to the
  // IANA zone name if the runtime doesn't emit a short form.
  try {
    const parts = new Intl.DateTimeFormat([], { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value
      ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      ?? "local";
  } catch {
    return "local";
  }
}
