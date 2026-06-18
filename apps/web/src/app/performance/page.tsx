import Link from "next/link";
import type { Metadata } from "next";
import { FilterPill } from "@/components/FilterPill";
import { FilterGroup } from "@/components/FilterGroup";
import { MethodFilter } from "@/components/MethodFilter";
import {
  BENCHMARKED_PROVIDERS,
  GEO_REGIONS,
  GEO_REGION_LABELS,
  cloudRegionsForGeo,
  type GeoRegion,
  type Method,
  WORKER_PROVIDER_LABELS,
} from "@rpcbench/shared";
import { type MethodWeights } from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { buildPageUrl } from "@/lib/apiParams";
import { ogImagePath, parseShareParams } from "@/lib/share";
import { Suspense } from "react";
import { ChartPanel, ChartLoading } from "@/components/ChartSection";
import {
  MethodRegionTabs,
  type BreakdownRow,
  type CubeRow,
  type InfraOption,
  type InfraTableData,
} from "@/components/MethodRegionTabs";
import { PerfScoreboard } from "@/components/PerfScoreboard";
import {
  buildMiniScoreRows,
  type MethodGeoRows,
  type MiniScoreRow,
} from "@/components/leaderboardShared";
import {
  fetchActiveGeos,
  fetchActiveInfraGeo,
  fetchActiveProviders,
  fetchAggregatesForGeo,
  fetchAggregatesForGeoByMethod,
  fetchMethodLatency,
  fetchMethodGeoLatency,
  type InfraGeoPair,
  type MethodLatencyRow,
  type MethodGeoLatencyRow,
} from "@/lib/leaderboard";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  /** Comma-separated geo subset blended into the chart + score. Empty = Overall. */
  regions?: string;
  /** Legacy single-region links (pre multi-select) — still accepted as a fallback. */
  region?: string;
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
  // Legacy single `?region=` links still resolve (one-geo subset).
  const geoSet = new Set<string>(GEO_REGIONS);
  const selectedGeos: GeoRegion[] = (params.regions ?? params.region ?? "")
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
  const chartMethods: readonly Method[] = selectedMethods;

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
    chartMethods,
    mwOverrides,
  };
}

function urlWith(
  params: SearchParams,
  override: Partial<Record<keyof SearchParams, string | null>>,
): string {
  return buildPageUrl("/performance", params, override);
}

/**
 * Build the (worker_provider, region) pair set for the chart query, respecting
 * the selected geo subset (or all geos for Overall) and the Infra filter.
 */
function chartCloudPairs(
  selectedGeos: GeoRegion[],
  selectedProvider: string | null,
): Array<{ worker_provider: string; region: string }> {
  const geos: readonly GeoRegion[] = selectedGeos.length > 0 ? selectedGeos : GEO_REGIONS;
  const out: Array<{ worker_provider: string; region: string }> = [];
  for (const g of geos) {
    for (const p of cloudRegionsForGeo(g)) {
      if (selectedProvider && p.worker_provider !== selectedProvider) continue;
      out.push(p);
    }
  }
  return out;
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

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const {
    selectedGeos,
    windowHours,
    connectionMode,
    selectedProvider,
    selectedBenchmarkedSet,
    selectedMethods,
    selectedMethod,
    selectedMethodSet,
    chartMethods,
    mwOverrides,
  } = parsePerformanceFilters(params);

  type GeoRows = { geo: GeoRegion; rows: Awaited<ReturnType<typeof fetchAggregatesForGeo>> };
  let regionTableCold: GeoRows[] = [];
  let regionTableWarm: GeoRows[] = [];
  let activeGeos: GeoRegion[] = [];
  let activeInfraGeo: InfraGeoPair[] = [];
  let activeProviders: string[] = [];
  // Per-infra table data: index i aligns with infraKeys[i] ("all" = pooled).
  let infraKeys: string[] = ["all"];
  let methodLatByInfra: MethodLatencyRow[][] = [];
  let methodGeoLatByInfra: MethodGeoLatencyRow[][] = [];
  // Per-(method, geo) cube for the tunable scoreboard — built only when >1 method
  // is selected (single method has nothing to reweight → cheaper prebuilt path).
  let cube: MethodGeoRows[] | null = null;
  let error: string | null = null;

  try {
    [activeGeos, activeInfraGeo, activeProviders] = await Promise.all([
      fetchActiveGeos(),
      fetchActiveInfraGeo(),
      fetchActiveProviders(),
    ]);
    // The table owns its own Infra filter (decoupled from the chart's `wp`), so
    // pre-fetch its per-infra aggregates for every active cloud (plus pooled
    // `all`) up front — the dropdown then switches client-side, no round-trip.
    infraKeys = ["all", ...activeProviders];
    const fetchGeoRows = (geos: GeoRegion[], mode: "cold" | "warm"): Promise<GeoRows[]> =>
      Promise.all(
        geos.map(async (g) => {
          const rows = await fetchAggregatesForGeo({
            geoRegion: g,
            windowHours,
            connectionMode: mode,
            method: selectedMethod,
            ...(selectedProvider ? { workerProvider: selectedProvider } : {}),
          });
          return { geo: g, rows };
        }),
      );
    const [mlByInfra, mglByInfra, regionColdRaw, regionWarmRaw] = await Promise.all([
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
      fetchGeoRows(activeGeos, "cold"),
      fetchGeoRows(activeGeos, "warm"),
    ]);
    regionTableCold = regionColdRaw;
    regionTableWarm = regionWarmRaw;
    methodLatByInfra = mlByInfra;
    methodGeoLatByInfra = mglByInfra;

    // Tunable scoreboard cube: when multiple methods are selected, fetch the
    // per-(method, geo) aggregates over the selected region subset (or all
    // active geos for Overall) and hand them to PerfScoreboard, which re-blends
    // client-side as the user tunes per-method weights. Single-method uses the
    // cheaper prebuilt buildMiniScoreRows path below (no extra fan-out).
    if (selectedMethods.length > 1) {
      const targets = selectedGeos.length > 0 ? selectedGeos : activeGeos;
      const built: MethodGeoRows[] = [];
      await Promise.all(
        targets.map(async (geo) => {
          const byMethod = await fetchAggregatesForGeoByMethod({
            geoRegion: geo,
            methods: selectedMethods,
            windowHours,
            connectionMode,
            ...(selectedProvider ? { workerProvider: selectedProvider } : {}),
          });
          for (const { method, rows } of byMethod) {
            const eligible = rows.filter(
              (r) => r.eligible === true && r.p50_ms != null && r.p95_ms != null,
            );
            built.push({ method, geo, rows, eligible });
          }
        }),
      );
      cube = built;
    }
  } catch (err) {
    console.error("[/performance]", err);
    error = DB_ERROR_MESSAGE;
  }

  // Build the per-method breakdown rows (columns = benchmarked providers; By
  // method pools all regions via fetchMethodLatency) for one infra. The By-region
  // rows are derived client-side in MethodRegionTabs from the per-infra cube, so
  // they're not built here. One of these is built per infra below.
  const tableProviders = BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).map((p) => ({
    id: p.id,
    name: p.name,
  }));
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
  // Assemble the per-infra table payload the dropdown switches between, plus the
  // dropdown options (`all` = pooled across clouds, then one per active cloud).
  const byInfra: Record<string, InfraTableData> = {};
  infraKeys.forEach((key, i) => {
    byInfra[key] = {
      methodRows: buildMethodRows(methodLatByInfra[i] ?? []),
      cubeRows: (methodGeoLatByInfra[i] ?? []) as CubeRow[],
    };
  });
  const infraOptions: InfraOption[] = [
    { id: "all", label: "All infra" },
    ...activeProviders.map((p) => ({ id: p, label: WORKER_PROVIDER_LABELS[p] ?? p })),
  ];

  // Context-aware filter coverage: which (infra, geo) pairs actually have
  // workers. Disable impossible combinations; the selected pill is never
  // disabled so an already-impossible URL can still be unwound.
  const geosByInfra = new Map<string, Set<GeoRegion>>();
  const infraByGeo = new Map<GeoRegion, Set<string>>();
  for (const { worker_provider, geo } of activeInfraGeo) {
    if (!geosByInfra.has(worker_provider)) geosByInfra.set(worker_provider, new Set());
    geosByInfra.get(worker_provider)!.add(geo);
    if (!infraByGeo.has(geo)) infraByGeo.set(geo, new Set());
    infraByGeo.get(geo)!.add(worker_provider);
  }
  const selectedGeoSet = new Set<GeoRegion>(selectedGeos);
  // A region is disabled when a single infra is selected that has no workers
  // there — but never disable a currently-selected region (so it can be toggled
  // off to unwind an impossible URL).
  const regionDisabled = (g: GeoRegion): boolean =>
    selectedProvider !== null &&
    !selectedGeoSet.has(g) &&
    !(geosByInfra.get(selectedProvider)?.has(g) ?? false);
  // An infra is disabled when a region subset is selected and none of those
  // regions have that infra's workers.
  const infraDisabled = (p: string): boolean =>
    selectedGeos.length > 0 &&
    p !== selectedProvider &&
    !selectedGeos.some((g) => infraByGeo.get(g)?.has(p) ?? false);

  const chartFilters = (
    <>
      <FilterGroup label="Region">
        <FilterPill active={selectedGeos.length === 0} href={urlWith(params, { regions: null })}>
          All
        </FilterPill>
        {activeGeos.map((g) => {
          // Toggle g in/out of the selected subset. Clearing the last one falls
          // back to All (regions removed from the URL).
          const inSel = selectedGeoSet.has(g);
          const next = inSel ? selectedGeos.filter((x) => x !== g) : [...selectedGeos, g];
          return (
            <FilterPill
              key={g}
              active={inSel}
              href={urlWith(params, { regions: next.length > 0 ? next.join(",") : null })}
              disabled={regionDisabled(g)}
              title={
                regionDisabled(g)
                  ? `No ${WORKER_PROVIDER_LABELS[selectedProvider!] ?? selectedProvider} workers in ${GEO_REGION_LABELS[g]}`
                  : undefined
              }
            >
              {GEO_REGION_LABELS[g]}
            </FilterPill>
          );
        })}
      </FilterGroup>
      {activeProviders.length > 1 && (
        <FilterGroup label="Infra">
          <FilterPill active={selectedProvider === null} href={urlWith(params, { wp: null })}>
            All
          </FilterPill>
          {activeProviders.map((p) => (
            <FilterPill
              key={p}
              active={p === selectedProvider}
              href={urlWith(params, { wp: p })}
              disabled={infraDisabled(p)}
              title={
                infraDisabled(p)
                  ? `No ${WORKER_PROVIDER_LABELS[p] ?? p} workers in the selected regions`
                  : undefined
              }
            >
              {WORKER_PROVIDER_LABELS[p] ?? p}
            </FilterPill>
          ))}
        </FilterGroup>
      )}
      <FilterGroup label="Window">
        {WINDOWS.map((w) => (
          <FilterPill
            key={w.value}
            active={w.value === windowHours}
            href={urlWith(params, { window: String(w.value) })}
          >
            {w.label}
          </FilterPill>
        ))}
      </FilterGroup>
      <FilterGroup label="Connection">
        <FilterPill active={connectionMode === "cold"} href={urlWith(params, { mode: null })}>
          Cold
        </FilterPill>
        <FilterPill active={connectionMode === "warm"} href={urlWith(params, { mode: "warm" })}>
          Warm
        </FilterPill>
      </FilterGroup>
      <FilterGroup label="Method">
        <MethodFilter
          multi
          selectedSet={selectedMethodSet}
          options={[...ALL_METHODS]
            .sort((a, b) => a.localeCompare(b))
            .map((m) => {
              // Checkbox: toggle m in/out of the selection; never empty (removing
              // the last selected method is a no-op). Name: select only m.
              const next = selectedMethodSet.has(m)
                ? selectedMethods.filter((x) => x !== m)
                : [...selectedMethods, m];
              const list = next.length > 0 ? next : selectedMethods;
              return {
                method: m,
                href: urlWith(params, { method: m }),
                toggleHref: urlWith(params, { method: list.join(",") }),
              };
            })}
          selected={selectedMethod}
        />
      </FilterGroup>
    </>
  );

  // Overall-score board (above the chart). Multi-method → hand the cube to
  // PerfScoreboard for client-side, tunable re-blending; single method → the
  // cheaper prebuilt path: blend the selected region subset (or all geos for
  // Overall) of the already-fetched per-geo aggregates, no extra fan-out.
  const scoreTable = connectionMode === "warm" ? regionTableWarm : regionTableCold;
  const filteredScoreTable =
    selectedGeos.length > 0 ? scoreTable.filter((o) => selectedGeoSet.has(o.geo)) : scoreTable;
  // When a cube is built (multi-method), PerfScoreboard ignores prebuiltRows; keep
  // it an array so the prop type stays exact under exactOptionalPropertyTypes.
  const prebuiltRows: MiniScoreRow[] =
    cube != null ? [] : buildMiniScoreRows(filteredScoreTable, null);

  // Effective regions for the share card: the selection, or all active geos when
  // Overall (so the OG card matches the on-screen blend).
  const shareRegions: GeoRegion[] = selectedGeos.length > 0 ? selectedGeos : activeGeos;
  // Reset the scoreboard's weight state when the method/region selection changes.
  const scoreboardKey = [selectedMethods.join(","), [...selectedGeos].sort().join(",")].join("|");

  const chartKey = [
    selectedGeos.join(",") || "all",
    windowHours,
    connectionMode,
    [...selectedMethods].sort().join(","),
    selectedProvider ?? "all",
  ].join("|");

  return (
    <div>
      <header className="pt-1 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-x-12 gap-y-6">
        <div className="max-w-[560px]">
          <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.025em] leading-[1.08] mt-2 mb-0 text-fg">
            Latency, by method &amp; region
          </h1>
          <p className="mt-3 text-[14.5px] leading-[1.6] text-fg2">
            A closer look behind the{" "}
            <Link href="/" className="text-accent hover:underline">
              Overview ranking
            </Link>
            : latency over time plus per-method and per-region breakdowns. Filter by
            region, infra, time window, connection mode, and method.
          </p>
        </div>
        <div className="w-full lg:w-[360px] shrink-0 lg:pt-3">
          <PerfScoreboard
            key={scoreboardKey}
            {...(cube ? { cube } : { prebuiltRows })}
            selectedMethods={selectedMethods}
            regions={shareRegions}
            mwOverrides={mwOverrides}
            windowHours={windowHours}
            mode={connectionMode}
            infra={selectedProvider ?? undefined}
          />
        </div>
      </header>

      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, margin: "16px 0" }}>
          DB error: {error}
        </div>
      )}

      {/* Performance over time. */}
      <section className="pt-1">
        <div className="flex justify-between items-start gap-8 mb-3">
          <div>
            <h2 className="text-[26px] font-medium tracking-[-0.022em] mt-0 mb-0">
              Performance over time
            </h2>
          </div>
        </div>

        <Suspense key={chartKey} fallback={<ChartLoading filters={chartFilters} windowHours={windowHours} />}>
          <ChartPanel
            cloudPairs={chartCloudPairs(selectedGeos, selectedProvider)}
            methods={chartMethods}
            windowHours={windowHours}
            connectionMode={connectionMode}
            initialBenchmarked={[...selectedBenchmarkedSet]}
            filters={chartFilters}
            selectedGeos={selectedGeos}
            workerProvider={selectedProvider ?? undefined}
          />
        </Suspense>
      </section>

      {/* Per-method & per-region latency breakdown (By method / By region). The
          table owns its own Infra + RPC dropdowns, decoupled from the chart. */}
      <MethodRegionTabs
        providers={tableProviders}
        byInfra={byInfra}
        infraOptions={infraOptions}
        selectedMethod={selectedMethod}
      />
    </div>
  );
}
