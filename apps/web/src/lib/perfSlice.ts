/**
 * A "perf slice" is everything the /performance chart + scoreboard render for
 * one (infra, connection-mode) combination: the latency series, the score
 * series, and the scoreboard payload (multi-method cube or single-method
 * prebuilt rows). `buildPerfSlice` is the single source of that shape — the
 * server (eager, for the current infra) and the /api/perf-slice route (lazy,
 * per-infra) both call it, so PerfExplorer renders eager-RSC and lazy-JSON
 * slices via the identical shape. All fields are plain JSON-serializable data.
 */
import {
  cloudRegionsForGeo,
  GEO_REGIONS,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import {
  fetchLatencySeries,
  type ChartSeries,
  type CloudPair,
} from "./chartData";
import {
  buildMethodGeoCube,
  fetchScoreSeries,
  withProviderFallback,
  type ScoreSeries,
} from "./leaderboard";
import {
  buildMiniScoreRows,
  type MethodGeoRows,
  type MiniScoreRow,
} from "@/components/leaderboardShared";

export interface PerfSlice {
  series: ChartSeries[];
  scoreSeries: ScoreSeries[];
  /** Multi-method → tunable cube; single method → server-computed rows. */
  scoreboard:
    | { kind: "cube"; cube: MethodGeoRows[] }
    | { kind: "prebuilt"; prebuiltRows: MiniScoreRow[] };
  /** Scoreboard providers shown from their own last ranking window → its ISO
   *  end; absent = live. The latency/score series stay live-only. */
  providerAsOf: Record<string, string>;
}

/**
 * (worker_provider, region) pairs for the chart query, respecting the selected
 * geo subset (or all geos for Overall) and the infra filter. Moved here from
 * performance/page.tsx so both the page and buildPerfSlice share it.
 */
export function chartCloudPairs(
  selectedGeos: readonly GeoRegion[],
  infra: string | null,
): CloudPair[] {
  const geos: readonly GeoRegion[] = selectedGeos.length > 0 ? selectedGeos : GEO_REGIONS;
  const out: CloudPair[] = [];
  for (const g of geos) {
    for (const p of cloudRegionsForGeo(g)) {
      if (infra && p.worker_provider !== infra) continue;
      out.push(p);
    }
  }
  return out;
}

export interface PerfSliceOpts {
  /** null = pooled "all infra". */
  infra: string | null;
  mode: "cold" | "warm";
  activeGeos: GeoRegion[];
  selectedGeos: GeoRegion[];
  /** The selected method list (first = single-method path when length 1). */
  methods: Method[];
  windowHours: number;
}

export async function buildPerfSlice(opts: PerfSliceOpts): Promise<PerfSlice> {
  const { infra, mode, activeGeos, selectedGeos, methods, windowHours } = opts;
  const wp = infra ?? undefined;
  const sortedMethods = [...new Set(methods)].sort();
  // Deliberately the RAW list: "the first method the user selected" drives the
  // single-method breakdown/region tables below. Using sortedMethods here would
  // silently redefine that as "alphabetically first".
  const selectedMethod = methods[0]!;

  const [series, scoreSeries] = await Promise.all([
    fetchLatencySeries({
      cloudPairs: chartCloudPairs(selectedGeos, infra),
      methods: sortedMethods,
      windowHours,
      connectionMode: mode,
    }),
    sortedMethods.length > 0
      ? fetchScoreSeries({
          selectedGeos,
          windowHours,
          connectionMode: mode,
          methods: sortedMethods,
          workerProvider: wp,
        })
      : Promise.resolve([] as ScoreSeries[]),
  ]);

  // Branch on the DEDUPED count: `?methods=getBlock,getBlock` is one method, and
  // must not escalate a cheap single-method request into the per-geo cube
  // fan-out (one leaderboard_agg query per geo) on a fresh cache key.
  // Both paths go through the per-provider stale fallback (withProviderFallback):
  // a provider the live window can't rank is scored from its own most recent
  // window that ranks it, listed in `providerAsOf`.
  let scoreboard: PerfSlice["scoreboard"];
  let providerAsOf: Record<string, string>;
  if (sortedMethods.length > 1) {
    const targets = selectedGeos.length > 0 ? selectedGeos : activeGeos;
    let cube: MethodGeoRows[];
    ({ cube, providerAsOf } = await withProviderFallback({
      windowHours,
      connectionMode: mode,
      label: "buildPerfSlice",
      build: (w) =>
        buildMethodGeoCube({
          geos: targets,
          methods: sortedMethods,
          connectionMode: mode,
          ...(wp ? { workerProvider: wp } : {}),
          w,
        }),
    }));
    scoreboard = { kind: "cube", cube };
  } else {
    // Ranked here = eligible in at least one geo, the default gate on a
    // one-method cube.
    const geos = selectedGeos.length > 0 ? activeGeos.filter((g) => selectedGeos.includes(g)) : activeGeos;
    let cube: MethodGeoRows[];
    ({ cube, providerAsOf } = await withProviderFallback({
      windowHours,
      connectionMode: mode,
      label: "buildPerfSlice",
      build: (w) =>
        buildMethodGeoCube({
          geos,
          methods: [selectedMethod],
          connectionMode: mode,
          ...(wp ? { workerProvider: wp } : {}),
          w,
        }),
    }));
    // Scored at the builder's default component weights. PerfScoreboard passes
    // the SAME weights to ScoreStrip (`weights={DEFAULT_WEIGHTS}`) so the
    // breakdown tooltip's formula matches these numbers — change one, change both.
    const rows = buildMiniScoreRows(cube.map(({ geo, rows }) => ({ geo, rows })), null);
    scoreboard = {
      kind: "prebuilt",
      prebuiltRows: rows.map((r) => ({ ...r, as_of: providerAsOf[r.provider_id] ?? null })),
    };
  }

  return { series, scoreSeries, scoreboard, providerAsOf };
}
