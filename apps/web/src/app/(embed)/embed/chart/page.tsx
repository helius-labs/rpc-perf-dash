import {
  BENCHMARKED_PROVIDERS,
  GEO_REGIONS,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { parseInfraOrPooled } from "@/lib/apiParams";
import { PerfExplorer } from "@/components/PerfExplorer";
import { buildPerfSlice, type PerfSlice } from "@/lib/perfSlice";
import {
  fetchActiveGeos,
  fetchActiveInfraGeo,
  fetchActiveProviders,
  type InfraGeoPair,
} from "@/lib/leaderboard";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  /** Benchmarked provider ids to pre-select in the RPC multi-select (helius,alchemy). */
  providers?: string;
  /** Alias accepted from the app's own share links. */
  bp?: string;
  regions?: string;
  window?: string;
  mode?: string;
  wp?: string;
  method?: string;
  /** Initial chart metric. `distribution` needs a single method (see below). */
  metric?: string;
  /** Initial latency percentile (p50 | p95). */
  pct?: string;
}

const DEFAULT_METHOD: Method = "getTransaction";
const METHOD_SET = new Set<string>(ALL_METHODS);
const GEO_SET = new Set<string>(GEO_REGIONS);
const PROVIDER_SET = new Set(BENCHMARKED_PROVIDERS.map((p) => p.id));

/**
 * Embeddable comparison chart — the FULL /performance chart (all filters: Region,
 * Infra, Window, Connection, Method, the RPC provider multi-select, plus the
 * metric / percentile / bin / outliers toggles), chrome-free. Reuses
 * <PerfExplorer> in embed mode so every filter works live inside the frame.
 *
 * `providers=helius,alchemy` seeds the RPC multi-select to a head-to-head; the
 * viewer can still toggle any provider on/off. Region/Window navigate within the
 * embed (pagePath below), so they never break out to the full site.
 */
export default async function EmbedChartPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const selectedGeos: GeoRegion[] = (params.regions ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is GeoRegion => GEO_SET.has(s));
  const windowHours = WINDOWS.some((w) => w.value === parseInt(params.window ?? "", 10))
    ? parseInt(params.window!, 10)
    : 24;
  const connectionMode: "cold" | "warm" = params.mode === "warm" ? "warm" : "cold";
  // Unknown infra coerces to pooled — a widget shouldn't hard-fail on a junk
  // param, and the raw value would otherwise fragment the unstable_cache key.
  const selectedProvider = parseInfraOrPooled(params.wp) ?? null;

  const selectedMethods: Method[] = (params.method ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Method => METHOD_SET.has(s));
  if (selectedMethods.length === 0) selectedMethods.push(DEFAULT_METHOD);

  // The Distribution metric is only offered for a single method (the chart's
  // `canDistribution` gate), so a multi-method `metric=distribution` link would
  // silently render Latency. Drop it here instead, so the URL and the view can't
  // disagree — score/latency are valid at any method count.
  const metricRaw = params.metric;
  const initialMetric: "latency" | "score" | "distribution" | undefined =
    metricRaw === "score"
      ? "score"
      : metricRaw === "distribution" && selectedMethods.length === 1
        ? "distribution"
        : metricRaw === "latency"
          ? "latency"
          : undefined;
  const initialPercentile: "p50" | "p95" | undefined =
    params.pct === "p50" ? "p50" : params.pct === "p95" ? "p95" : undefined;

  // `providers=` (or the app's `bp=`) → the RPC multi-select seed. Empty = show all.
  const initialBenchmarked = (params.providers ?? params.bp ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => PROVIDER_SET.has(s));

  let activeGeos: GeoRegion[] = [];
  let activeInfraGeo: InfraGeoPair[] = [];
  let activeProviders: string[] = [];
  let initialSlices: { cold: PerfSlice; warm: PerfSlice } | null = null;
  let error: string | null = null;
  try {
    [activeGeos, activeInfraGeo, activeProviders] = await Promise.all([
      fetchActiveGeos(),
      fetchActiveInfraGeo(),
      fetchActiveProviders(),
    ]);
    const [cold, warm] = await Promise.all([
      buildPerfSlice({ infra: selectedProvider, mode: "cold", activeGeos, selectedGeos, methods: selectedMethods, windowHours }),
      buildPerfSlice({ infra: selectedProvider, mode: "warm", activeGeos, selectedGeos, methods: selectedMethods, windowHours }),
    ]);
    initialSlices = { cold, warm };
  } catch (err) {
    console.error("[embed/chart]", err);
    error = DB_ERROR_MESSAGE;
  }

  if (error || !initialSlices) {
    return (
      <div className="badge bad" style={{ display: "block", padding: 12 }} role="alert">
        Chart unavailable: {error ?? DB_ERROR_MESSAGE}
      </div>
    );
  }

  // Context maps for disabling filter pills that have no data (same as /performance).
  const geosByInfra: Record<string, GeoRegion[]> = {};
  const infraByGeo: Record<string, string[]> = {};
  for (const { worker_provider, geo } of activeInfraGeo) {
    (geosByInfra[worker_provider] ??= []).push(geo);
    (infraByGeo[geo] ??= []).push(worker_provider);
  }

  return (
    <PerfExplorer
      embed
      pagePath="/embed/chart"
      initialInfra={selectedProvider}
      initialMode={connectionMode}
      initialSlices={initialSlices}
      baseParams={params as Record<string, string | undefined>}
      selectedGeos={selectedGeos}
      activeGeos={activeGeos}
      activeProviders={activeProviders}
      windowHours={windowHours}
      selectedMethods={selectedMethods}
      geosByInfra={geosByInfra}
      infraByGeo={infraByGeo}
      mwOverrides={{}}
      shareRegions={selectedGeos.length > 0 ? selectedGeos : activeGeos}
      initialBenchmarked={initialBenchmarked}
      initialMetric={initialMetric}
      initialPercentile={initialPercentile}
    />
  );
}
