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
import { parseInfraOrPooled } from "@/lib/apiParams";
import { ogImagePath, parseShareParams } from "@/lib/share";
import { canonicalUrl, NOINDEX } from "@/lib/seo";
import {
  MethodRegionTabs,
  type InfraOption,
  type InfraTableData,
} from "@/components/MethodRegionTabs";
import { PerfExplorer } from "@/components/PerfExplorer";
import { LatencyChart } from "@/components/LatencyChart";
import { SendMethodRegionTabs } from "@/components/SendMethodRegionTabs";
import { ScoreStrip } from "@/components/ScoreStrip";
import { SendsShareButton } from "@/components/SendsShareButton";
import type { MiniScoreRow } from "@/components/leaderboardShared";
import { DEFAULT_SEND_WEIGHTS } from "@rpcbench/shared/sendScoring";
import { targetLabel } from "@/lib/sendLabels";
import { fetchSendChart, fetchSendTableData, fetchSendBoard } from "@/lib/sends";
import { buildPerfSlice, type PerfSlice } from "@/lib/perfSlice";
import {
  fetchActiveGeos,
  fetchActiveInfraGeo,
  fetchActiveProviders,
  type InfraGeoPair,
} from "@/lib/leaderboard";
import { buildLatencyTableData } from "@/lib/embedData";
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
  // Unknown infra coerces to pooled rather than reaching an unstable_cache key
  // (a junk `?wp=` would otherwise be a guaranteed miss on the heavy fetchers).
  const selectedProvider: string | null = parseInfraOrPooled(params.wp) ?? null;
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
    // Noindex unconditionally — not just the parameterized forms. This is a
    // deep-dive view of the same data the indexed leaderboards cover, and its
    // 8 filter params made it a top source of near-duplicate indexed URLs.
    // Self-canonical: it's a real page, just not one we want ranking.
    robots: NOINDEX,
    alternates: { canonical: canonicalUrl("/performance") },
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
  // Remount PerfExplorer when a server-nav filter (region / window) changes, so
  // its slice cache (seeded from initialSlices via useState) picks up the fresh
  // server data instead of showing the stale first-mount cache. Infra/mode AND
  // method are excluded — they're all client state now and don't trigger a nav
  // (method swaps a client-fetched slice, keyed by (infra, methods)).
  const perfKey = [[...selectedGeos].sort().join(",") || "all", windowHours].join("|");

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
      geosByInfra={geosByInfra}
      infraByGeo={infraByGeo}
      mwOverrides={mwOverrides}
      shareRegions={shareRegions}
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
  let byInfra: Record<string, InfraTableData> = {};
  try {
    byInfra = await buildLatencyTableData({ infraKeys, windowHours, tableProviders });
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
      windowHours={windowHours}
    />
  );
}

/**
 * Sends performance view: the SAME LatencyChart (send data) + a scenario ×
 * region × target breakdown table that mirrors the RPC latency table
 * (<SendMethodRegionTabs>), with a metric selector (landing / slot / wall /
 * block / cost) in place of the RPC cold/warm toggle.
 */
// 2-axis weight caption for the sends mini leaderboard (analogue of the RPC
// ScoreStrip's 5-axis WEIGHT_SUMMARY).
const SEND_WEIGHT_SUMMARY = `Reliability ${Math.round(DEFAULT_SEND_WEIGHTS.reliability * 100)}% · Latency ${Math.round(DEFAULT_SEND_WEIGHTS.latency * 100)}%`;

/** Board rows (already scored + ranked server-side) → ScoreStrip mini rows. */
function sendMiniRows(board: Awaited<ReturnType<typeof fetchSendBoard>>): MiniScoreRow[] {
  return board
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ provider_id: r.send_target, provider_name: targetLabel(r.send_target), total: r.total }));
}

async function SendsPerfHero() {
  let chart: Awaited<ReturnType<typeof fetchSendChart>>;
  let table: Awaited<ReturnType<typeof fetchSendTableData>>;
  let board: Awaited<ReturnType<typeof fetchSendBoard>>;
  try {
    [chart, table, board] = await Promise.all([
      fetchSendChart("1h", 48),
      fetchSendTableData("1d"),
      fetchSendBoard("1d"),
    ]);
  } catch (err) {
    console.error("[SendsPerfHero]", err);
    return (
      <div className="badge bad" style={{ display: "block", padding: 12, margin: "16px 0" }} role="alert">
        Sends performance unavailable: {DB_ERROR_MESSAGE}
      </div>
    );
  }
  return (
    <div className="pt-1">
      {/* Two-column header identical to the RPC perf page (PerfExplorer): title +
          description on the left, the ranked send-target mini leaderboard
          (ScoreStrip + Share, analogue of the RPC PerfScoreboard) in a fixed
          right column — NOT full-width. */}
      <header className="pt-1 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-x-12 gap-y-6 mb-6">
        <div className="max-w-[560px]">
          <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.025em] leading-[1.08] mt-2 mb-0 text-fg">
            Sends performance
          </h1>
          <p className="mt-3 text-[14.5px] leading-[1.6] text-fg2">
            Landing latency and landing rate over time per send target. The chart&apos;s
            Latency series plots wall-latency (ms); Score plots landing rate (%).
          </p>
        </div>
        <div className="w-full lg:w-[360px] shrink-0 lg:pt-3">
          <ScoreStrip rows={sendMiniRows(board)} ranked={board.length > 0} weightSummary={SEND_WEIGHT_SUMMARY} />
          <div className="flex justify-end items-center gap-3 mt-3">
            <SendsShareButton weights={DEFAULT_SEND_WEIGHTS} />
          </div>
        </div>
      </header>
      <LatencyChart series={chart.series} scoreSeries={chart.scoreSeries} windowHours={48} connectionMode="warm" />
      {table.targets.length > 0 && (
        <SendMethodRegionTabs
          targets={table.targets}
          byInfra={table.byInfra}
          infraOptions={table.infraOptions}
        />
      )}
    </div>
  );
}

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const board: "rpcs" | "sends" = (params as { board?: string }).board === "sends" ? "sends" : "rpcs";
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

      {board === "sends" ? (
        <Suspense fallback={<PerfHeroSkeleton />}>
          <SendsPerfHero />
        </Suspense>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
