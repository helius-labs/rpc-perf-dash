import type { Metadata } from "next";
import { Suspense } from "react";
import {
  BENCHMARKED_PROVIDERS,
  GEO_REGIONS,
  type GeoRegion,
  type Method,
  WORKER_PROVIDER_LABELS,
} from "@rpcbench/shared";
import { type MethodWeights } from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { ogImagePath, parseShareParams } from "@/lib/share";
import {
  MethodRegionTabs,
  type BreakdownRow,
  type CubeRow,
  type InfraOption,
  type InfraTableData,
} from "@/components/MethodRegionTabs";
import { PerfExplorer } from "@/components/PerfExplorer";
import { buildPerfSlice, type PerfSlice } from "@/lib/perfSlice";
import {
  fetchActiveGeos,
  fetchActiveInfraGeo,
  fetchActiveProviders,
  fetchMethodLatency,
  fetchMethodGeoLatency,
  type InfraGeoPair,
  type MethodLatencyRow,
} from "@/lib/leaderboard";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  /** Comma-separated geo subset blended into the chart + score. Empty = Overall. */
  regions?: string;
  window?: string;
  mode?: string;
  wp?: string;
  bp?: string;
  method?: string;
  /** Sparse per-method weight overrides (`method:weight,…`), shared via ShareButton. */
  mw?: string;
}

const DEFAULT_METHOD: Method = "getTransaction";

/** Parse the /performance query params into the page's filter state. */
function parsePerformanceFilters(params: SearchParams) {
  // `?regions=` is a comma-separated geo subset; empty = Overall (all active).
  const geoSet = new Set<string>(GEO_REGIONS);
  const selectedGeos: GeoRegion[] = (params.regions ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is GeoRegion => geoSet.has(s));
  const windowHours = WINDOWS.some((w) => w.value === parseInt(params.window ?? "", 10))
    ? parseInt(params.window!, 10)
    : 24;
  const connectionMode = (params.mode ?? "cold") as "cold" | "warm";
  const wpRaw = params.wp ?? "all";
  const selectedProvider: string | null = wpRaw === "all" ? null : wpRaw;
  const selectedBenchmarkedSet = new Set<string>(
    (params.bp ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "all"),
  );

  // `?method=` is a comma-separated list; the chart blends the score across all
  // of them. The breakdown/region tables are per-method, so they key off the
  // first selected method.
  const methodSet = new Set<string>(ALL_METHODS);
  const selectedMethods: Method[] = (params.method ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Method => methodSet.has(s));
  if (selectedMethods.length === 0) selectedMethods.push(DEFAULT_METHOD);
  const selectedMethod: Method = selectedMethods[0]!;
  const selectedMethodSet = new Set<string>(selectedMethods);

  // Sparse per-method weight overrides from `?mw=` (method:weight,…) — seeds the
  // scoreboard's tunable weights so a shared link reproduces the tuned view.
  const mwOverrides: MethodWeights = {};
  for (const pair of (params.mw ?? "").split(",")) {
    const [m, wStr] = pair.split(":");
    const w = Number(wStr);
    if (m && methodSet.has(m) && Number.isFinite(w) && w >= 0) mwOverrides[m as Method] = w;
  }

  return {
    selectedGeos,
    windowHours,
    connectionMode,
    selectedProvider,
    selectedBenchmarkedSet,
    selectedMethods,
    selectedMethod,
    selectedMethodSet,
    mwOverrides,
  };
}

// Per-view social card. Region/window/mode/method query keys line up with this
// page's own params; the ShareButton additionally encodes infra + (default)
// weights so a tweeted link's card matches the filtered view.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const filters = parseShareParams(params as Record<string, string | undefined>);
  const windowLabel =
    WINDOWS.find((w) => w.value === filters.windowHours)?.label ?? `${filters.windowHours}h`;
  const methodLabel =
    filters.methods.length === 1 ? filters.methods[0] : `${filters.methods.length} methods`;
  const title = `Solana RPC Benchmark — ${methodLabel} performance`;
  const description = `Latency and rankings for ${methodLabel} across regions and clouds (last ${windowLabel}).`;
  const image = ogImagePath(filters);
  return {
    title,
    description,
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

// Pulsing placeholders shown while each section's data streams in.
function PerfHeroSkeleton() {
  return (
    <div className="pt-1" aria-hidden="true">
      <div className="h-[42px] w-[60%] max-w-[560px] rounded bg-[color-mix(in_srgb,var(--text)_6%,transparent)] animate-pulse mb-6" />
      <div className="h-[200px] w-full rounded-lg border border-line bg-[color-mix(in_srgb,var(--text)_3%,transparent)] animate-pulse mb-6" />
      <div className="border-t border-line h-[360px] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] animate-pulse" />
    </div>
  );
}
function TableSkeleton() {
  return (
    <section className="pt-10" aria-hidden="true">
      <div className="h-[28px] w-[220px] rounded bg-[color-mix(in_srgb,var(--text)_6%,transparent)] animate-pulse mb-4" />
      <div className="border-t border-line h-[320px] bg-[color-mix(in_srgb,var(--text)_3%,transparent)] animate-pulse" />
    </section>
  );
}

/**
 * Header (title + scoreboard) and the latency-over-time chart, driven by the
 * client `PerfExplorer`. Eagerly fetches BOTH connection modes for the current
 * infra so the cold/warm toggle is instant from first paint; other infras are
 * lazy-loaded client-side via /api/perf-slice. Streams in its own <Suspense>.
 */
async function PerfHero({
  parsed,
  params,
  activeGeos,
  activeProviders,
  geosByInfra,
  infraByGeo,
}: {
  parsed: ReturnType<typeof parsePerformanceFilters>;
  params: SearchParams;
  activeGeos: GeoRegion[];
  activeProviders: string[];
  geosByInfra: Record<string, GeoRegion[]>;
  infraByGeo: Record<string, string[]>;
}) {
  const {
    selectedProvider,
    selectedGeos,
    selectedMethods,
    selectedMethod,
    selectedMethodSet,
    windowHours,
    connectionMode,
    mwOverrides,
    selectedBenchmarkedSet,
  } = parsed;

  let initialSlices: { cold: PerfSlice; warm: PerfSlice };
  try {
    const [cold, warm] = await Promise.all([
      buildPerfSlice({ infra: selectedProvider, mode: "cold", activeGeos, selectedGeos, methods: selectedMethods, windowHours }),
      buildPerfSlice({ infra: selectedProvider, mode: "warm", activeGeos, selectedGeos, methods: selectedMethods, windowHours }),
    ]);
    initialSlices = { cold, warm };
  } catch (err) {
    console.error("[PerfHero]", err);
    return (
      <div className="badge bad" style={{ display: "block", padding: 12, margin: "16px 0" }} role="alert">
        Performance data unavailable: {DB_ERROR_MESSAGE}
      </div>
    );
  }

  const shareRegions: GeoRegion[] = selectedGeos.length > 0 ? selectedGeos : activeGeos;
  const scoreboardKey = [selectedMethods.join(","), [...selectedGeos].sort().join(",")].join("|");
  // Remount PerfExplorer when a server-nav filter (region / window / method)
  // changes, so its slice cache (seeded from initialSlices via useState) picks
  // up the fresh server data instead of showing the stale first-mount cache.
  // Infra/mode are excluded — they're client state and don't trigger a nav.
  const perfKey = [
    [...selectedGeos].sort().join(",") || "all",
    windowHours,
    [...selectedMethods].sort().join(","),
  ].join("|");

  return (
    <PerfExplorer
      key={perfKey}
      initialInfra={selectedProvider}
      initialMode={connectionMode}
      initialSlices={initialSlices}
      baseParams={params as Record<string, string | undefined>}
      selectedGeos={selectedGeos}
      activeGeos={activeGeos}
      activeProviders={activeProviders}
      windowHours={windowHours}
      selectedMethods={selectedMethods}
      selectedMethod={selectedMethod}
      selectedMethodSet={[...selectedMethodSet]}
      geosByInfra={geosByInfra}
      infraByGeo={infraByGeo}
      mwOverrides={mwOverrides}
      shareRegions={shareRegions}
      scoreboardKey={scoreboardKey}
      initialBenchmarked={[...selectedBenchmarkedSet]}
    />
  );
}

/**
 * Per-method / per-region latency breakdown table. Streams independently. Owns
 * its own Infra + RPC dropdowns (decoupled from the chart), so it pre-fetches
 * every infra key's table data up front for client-side switching.
 */
async function LatencyTablePanel({
  infraKeys,
  windowHours,
  tableProviders,
  infraOptions,
  selectedMethod,
}: {
  infraKeys: string[];
  windowHours: number;
  tableProviders: { id: string; name: string }[];
  infraOptions: InfraOption[];
  selectedMethod: Method;
}) {
  const byInfra: Record<string, InfraTableData> = {};
  try {
    const [mlByInfra, mglByInfra] = await Promise.all([
      Promise.all(
        infraKeys.map((k) =>
          fetchMethodLatency({ windowHours, ...(k !== "all" ? { workerProvider: k } : {}) }),
        ),
      ),
      Promise.all(
        infraKeys.map((k) =>
          fetchMethodGeoLatency({ windowHours, ...(k !== "all" ? { workerProvider: k } : {}) }),
        ),
      ),
    ]);
    const buildMethodRows = (ml: MethodLatencyRow[]): BreakdownRow[] =>
      [...ALL_METHODS]
        .sort((a, b) => a.localeCompare(b))
        .map((m) => ({
          key: m,
          label: m,
          isCode: true,
          values: Object.fromEntries(
            tableProviders.map((p) => {
              const cold = ml.find(
                (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "cold",
              );
              const warm = ml.find(
                (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "warm",
              );
              return [
                p.id,
                {
                  cold: { p50: cold?.p50 ?? null, p95: cold?.p95 ?? null },
                  warm: { p50: warm?.p50 ?? null, p95: warm?.p95 ?? null },
                },
              ];
            }),
          ),
        }));
    infraKeys.forEach((key, i) => {
      byInfra[key] = {
        methodRows: buildMethodRows(mlByInfra[i] ?? []),
        cubeRows: (mglByInfra[i] ?? []) as CubeRow[],
      };
    });
  } catch (err) {
    console.error("[LatencyTablePanel]", err);
    return (
      <div
        className="badge bad"
        style={{ display: "block", padding: 12, marginTop: 40 }}
        role="alert"
      >
        Latency table unavailable: {DB_ERROR_MESSAGE}
      </div>
    );
  }
  return (
    <MethodRegionTabs
      providers={tableProviders}
      byInfra={byInfra}
      infraOptions={infraOptions}
      selectedMethod={selectedMethod}
    />
  );
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const parsed = parsePerformanceFilters(params);

  // Only the cheap "shell" data is awaited here (active geos / infra / providers
  // — small distinct-value queries), so the page shell renders immediately. The
  // heavy per-section data streams inside the two <Suspense> boundaries below.
  let activeGeos: GeoRegion[] = [];
  let activeInfraGeo: InfraGeoPair[] = [];
  let activeProviders: string[] = [];
  let shellError: string | null = null;
  try {
    [activeGeos, activeInfraGeo, activeProviders] = await Promise.all([
      fetchActiveGeos(),
      fetchActiveInfraGeo(),
      fetchActiveProviders(),
    ]);
  } catch (err) {
    console.error("[/performance shell]", err);
    shellError = DB_ERROR_MESSAGE;
  }

  const tableProviders = BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const infraKeys: string[] = ["all", ...activeProviders];
  const infraOptions: InfraOption[] = [
    { id: "all", label: "All infra" },
    ...activeProviders.map((p) => ({ id: p, label: WORKER_PROVIDER_LABELS[p] ?? p })),
  ];

  // Context-aware filter coverage as plain objects (which (infra, geo) pairs
  // have workers) — PerfExplorer recomputes disabled pills client-side from live
  // infra/region state, so it needs these serializable maps.
  const geosByInfra: Record<string, GeoRegion[]> = {};
  const infraByGeo: Record<string, string[]> = {};
  for (const { worker_provider, geo } of activeInfraGeo) {
    (geosByInfra[worker_provider] ??= []).push(geo);
    (infraByGeo[geo] ??= []).push(worker_provider);
  }

  return (
    <div>
      {shellError && (
        <div className="badge bad" style={{ display: "block", padding: 12, margin: "16px 0" }}>
          DB error: {shellError}
        </div>
      )}

      <Suspense fallback={<PerfHeroSkeleton />}>
        <PerfHero
          parsed={parsed}
          params={params}
          activeGeos={activeGeos}
          activeProviders={activeProviders}
          geosByInfra={geosByInfra}
          infraByGeo={infraByGeo}
        />
      </Suspense>

      {/* Per-method & per-region latency breakdown — heaviest fan-out, streams
          in its own boundary so a slow per-infra query never blocks the chart. */}
      <Suspense fallback={<TableSkeleton />}>
        <LatencyTablePanel
          infraKeys={infraKeys}
          windowHours={parsed.windowHours}
          tableProviders={tableProviders}
          infraOptions={infraOptions}
          selectedMethod={parsed.selectedMethod}
        />
      </Suspense>
    </div>
  );
}
