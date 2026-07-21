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
  fetchScoreSeries,
  fetchAggregatesForGeo,
  fetchAggregatesForGeoByMethod,
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
  const selectedMethod = methods[0]!;

  const [series, scoreSeries] = await Promise.all([
    fetchLatencySeries({
      cloudPairs: chartCloudPairs(selectedGeos, infra),
      methods,
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

  let scoreboard: PerfSlice["scoreboard"];
  if (methods.length > 1) {
    const targets = selectedGeos.length > 0 ? selectedGeos : activeGeos;
    const built: MethodGeoRows[] = [];
    await Promise.all(
      targets.map(async (geo) => {
        const byMethod = await fetchAggregatesForGeoByMethod({
          geoRegion: geo,
          methods,
          windowHours,
          connectionMode: mode,
          ...(wp ? { workerProvider: wp } : {}),
        });
        for (const { method, rows } of byMethod) {
          const eligible = rows.filter(
            (r) => r.eligible === true && r.p50_ms != null && r.p95_ms != null,
          );
          built.push({ method, geo, rows, eligible });
        }
      }),
    );
    scoreboard = { kind: "cube", cube: built };
  } else {
    const selectedSet = new Set(selectedGeos);
    const regionRows = await Promise.all(
      activeGeos.map(async (g) => ({
        geo: g,
        rows: await fetchAggregatesForGeo({
          geoRegion: g,
          windowHours,
          connectionMode: mode,
          method: selectedMethod,
          ...(wp ? { workerProvider: wp } : {}),
        }),
      })),
    );
    const filtered =
      selectedGeos.length > 0 ? regionRows.filter((o) => selectedSet.has(o.geo)) : regionRows;
    scoreboard = { kind: "prebuilt", prebuiltRows: buildMiniScoreRows(filtered, null) };
  }

  return { series, scoreSeries, scoreboard };
}
