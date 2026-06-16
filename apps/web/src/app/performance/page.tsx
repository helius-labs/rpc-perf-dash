import Link from "next/link";
import type { Metadata } from "next";
import { FilterPill } from "@/components/FilterPill";
import { FilterGroup } from "@/components/FilterGroup";
import { MethodFilter } from "@/components/MethodFilter";
import { ShareButton } from "@/components/ShareButton";
import {
  BENCHMARKED_PROVIDERS,
  GEO_REGIONS,
  GEO_REGION_LABELS,
  cloudRegionsForGeo,
  type GeoRegion,
  type Method,
  WORKER_PROVIDER_LABELS,
} from "@rpcbench/shared";
import { DEFAULT_WEIGHTS } from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { ogImagePath, parseShareParams, type ShareFilters } from "@/lib/share";
import { Suspense } from "react";
import { ChartPanel, ChartLoading } from "@/components/ChartSection";
import { MethodRegionTabs } from "@/components/MethodRegionTabs";
import { ScoreStrip } from "@/components/ScoreStrip";
import { buildMiniScoreRows } from "@/components/leaderboardShared";
import {
  fetchActiveGeos,
  fetchActiveInfraGeo,
  fetchActiveProviders,
  fetchAggregatesForGeo,
  fetchMethodLatency,
  fetchMethodGeoLatency,
  type InfraGeoPair,
  type MethodLatencyRow,
  type MethodGeoLatencyRow,
} from "@/lib/leaderboard";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  region?: string;
  window?: string;
  mode?: string;
  wp?: string;
  bp?: string;
  method?: string;
}

function urlWith(
  params: SearchParams,
  override: Partial<Record<keyof SearchParams, string | null>>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v != null) merged[k] = String(v);
  for (const [k, v] of Object.entries(override)) {
    if (v === null) delete merged[k];
    else if (v != null) merged[k] = String(v);
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/performance?${qs}` : "/performance";
}

/**
 * Build the (worker_provider, region) pair set for the chart query, respecting
 * the selected geo (or all geos for Overall) and the Infra filter.
 */
function chartCloudPairs(
  selectedGeo: GeoRegion | null,
  selectedProvider: string | null,
): Array<{ worker_provider: string; region: string }> {
  const geos: readonly GeoRegion[] = selectedGeo ? [selectedGeo] : GEO_REGIONS;
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
  const title = `Solana RPC Benchmark — ${filters.method} performance`;
  const description = `Latency and rankings for ${filters.method} across regions and clouds (last ${windowLabel}).`;
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
  const selectedGeo = (GEO_REGIONS as readonly string[]).includes(params.region ?? "")
    ? (params.region as GeoRegion)
    : null;
  const windowHours = WINDOWS.some((w) => w.value === parseInt(params.window ?? "", 10))
    ? parseInt(params.window!, 10)
    : 24;
  const connectionMode = (params.mode ?? "cold") as "cold" | "warm";
  const wpRaw = params.wp ?? "all";
  const selectedProvider: string | null = wpRaw === "all" ? null : wpRaw;
  const selectedBenchmarkedSet = new Set<string>(
    (params.bp ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== "all"),
  );

  const DEFAULT_METHOD: Method = "getTransaction";
  const methodRaw = params.method ?? DEFAULT_METHOD;
  const selectedMethod: Method = (ALL_METHODS as readonly string[]).includes(methodRaw)
    ? (methodRaw as Method)
    : DEFAULT_METHOD;
  const chartMethods: readonly Method[] = [selectedMethod];

  type GeoRows = { geo: GeoRegion; rows: Awaited<ReturnType<typeof fetchAggregatesForGeo>> };
  let regionTableCold: GeoRows[] = [];
  let regionTableWarm: GeoRows[] = [];
  let activeGeos: GeoRegion[] = [];
  let activeInfraGeo: InfraGeoPair[] = [];
  let activeProviders: string[] = [];
  let methodLat: MethodLatencyRow[] = [];
  let methodGeoLat: MethodGeoLatencyRow[] = [];
  let error: string | null = null;

  try {
    [activeGeos, activeInfraGeo] = await Promise.all([fetchActiveGeos(), fetchActiveInfraGeo()]);
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
    const [providers, ml, mgl, regionColdRaw, regionWarmRaw] = await Promise.all([
      fetchActiveProviders(),
      fetchMethodLatency({
        windowHours,
        ...(selectedProvider ? { workerProvider: selectedProvider } : {}),
      }),
      fetchMethodGeoLatency({
        windowHours,
        ...(selectedProvider ? { workerProvider: selectedProvider } : {}),
      }),
      fetchGeoRows(activeGeos, "cold"),
      fetchGeoRows(activeGeos, "warm"),
    ]);
    regionTableCold = regionColdRaw;
    regionTableWarm = regionWarmRaw;
    activeProviders = providers;
    methodLat = ml;
    methodGeoLat = mgl;
  } catch (err) {
    console.error("[/performance]", err);
    error = DB_ERROR_MESSAGE;
  }

  // Build the per-method & per-region breakdown tables. Columns = benchmarked
  // providers; By method pools all regions (fetchMethodLatency), By region
  // reuses the per-geo aggregates loaded above.
  const tableProviders = BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const methodBreakdownRows = [...ALL_METHODS]
    .sort((a, b) => a.localeCompare(b))
    .map((m) => ({
      key: m,
      label: m,
      isCode: true,
      values: Object.fromEntries(
        tableProviders.map((p) => {
          const cold = methodLat.find(
            (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "cold",
          );
          const warm = methodLat.find(
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
  const warmRowsByGeo = new Map(regionTableWarm.map((o) => [o.geo, o.rows]));
  const regionBreakdownRows = regionTableCold.map((o) => {
    const warmRows = warmRowsByGeo.get(o.geo) ?? [];
    return {
      key: o.geo,
      label: GEO_REGION_LABELS[o.geo],
      isCode: false,
      values: Object.fromEntries(
        tableProviders.map((p) => {
          const cold = o.rows.find((r) => r.provider_id === p.id);
          const warm = warmRows.find((r) => r.provider_id === p.id);
          return [
            p.id,
            {
              cold: { p50: cold?.p50_ms ?? null, p95: cold?.p95_ms ?? null },
              warm: { p50: warm?.p50_ms ?? null, p95: warm?.p95_ms ?? null },
            },
          ];
        }),
      ),
    };
  });

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
  const regionDisabled = (g: GeoRegion): boolean =>
    selectedProvider !== null && g !== selectedGeo && !(geosByInfra.get(selectedProvider)?.has(g) ?? false);
  const infraDisabled = (p: string): boolean =>
    selectedGeo !== null && p !== selectedProvider && !(infraByGeo.get(selectedGeo)?.has(p) ?? false);

  const chartFilters = (
    <>
      <FilterGroup label="Region">
        <FilterPill active={selectedGeo === null} href={urlWith(params, { region: null })}>
          Overall
        </FilterPill>
        {activeGeos.map((g) => (
          <FilterPill
            key={g}
            active={g === selectedGeo}
            href={urlWith(params, { region: g })}
            disabled={regionDisabled(g)}
            title={
              regionDisabled(g)
                ? `No ${WORKER_PROVIDER_LABELS[selectedProvider!] ?? selectedProvider} workers in ${GEO_REGION_LABELS[g]}`
                : undefined
            }
          >
            {GEO_REGION_LABELS[g]}
          </FilterPill>
        ))}
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
                  ? `No ${WORKER_PROVIDER_LABELS[p] ?? p} workers in ${GEO_REGION_LABELS[selectedGeo!]}`
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
          options={[...ALL_METHODS]
            .sort((a, b) => a.localeCompare(b))
            .map((m) => ({ method: m, href: urlWith(params, { method: m }) }))}
          selected={selectedMethod}
        />
      </FilterGroup>
    </>
  );

  // Overall-score board (above the chart) — reuses the Overview's scoring
  // pipeline over the already-fetched per-geo aggregates for the active
  // connection mode, so it tracks the current region/infra/window/method.
  const scoreTable = connectionMode === "warm" ? regionTableWarm : regionTableCold;
  const miniScores = buildMiniScoreRows(scoreTable, selectedGeo);
  const scoresRanked = miniScores.some((r) => r.total > 0);

  const chartKey = [
    selectedGeo ?? "all",
    windowHours,
    connectionMode,
    selectedMethod,
    selectedProvider ?? "all",
  ].join("|");

  // Share-card filters track the active chart filters. Performance doesn't tune
  // scoring weights, so it shares the documented defaults.
  const shareFilters: ShareFilters = {
    method: selectedMethod,
    region: selectedGeo ?? "overall",
    mode: connectionMode,
    windowHours,
    infra: selectedProvider ?? undefined,
    weights: DEFAULT_WEIGHTS,
  };

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
          <ScoreStrip rows={miniScores} ranked={scoresRanked} />
          <div className="flex justify-end mt-3">
            <ShareButton filters={shareFilters} pagePath="/performance" />
          </div>
        </div>
      </header>

      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, margin: "16px 0" }}>
          DB error: {error}
        </div>
      )}

      {/* Performance over time. */}
      <section className="pt-4">
        <div className="flex justify-between items-start gap-8 mb-3">
          <div>
            <h2 className="text-[26px] font-medium tracking-[-0.022em] mt-2 mb-0">
              Performance over time
            </h2>
          </div>
        </div>

        <Suspense key={chartKey} fallback={<ChartLoading filters={chartFilters} windowHours={windowHours} />}>
          <ChartPanel
            cloudPairs={chartCloudPairs(selectedGeo, selectedProvider)}
            methods={chartMethods}
            windowHours={windowHours}
            connectionMode={connectionMode}
            initialBenchmarked={[...selectedBenchmarkedSet]}
            filters={chartFilters}
            selectedGeo={selectedGeo}
            workerProvider={selectedProvider ?? undefined}
          />
        </Suspense>
      </section>

      {/* Per-method & per-region latency breakdown (By method / By region). */}
      <MethodRegionTabs
        providers={tableProviders}
        methodRows={methodBreakdownRows}
        regionRows={regionBreakdownRows}
        cubeRows={methodGeoLat}
        infraLabel={
          selectedProvider ? (WORKER_PROVIDER_LABELS[selectedProvider] ?? selectedProvider) : undefined
        }
      />
    </div>
  );
}
