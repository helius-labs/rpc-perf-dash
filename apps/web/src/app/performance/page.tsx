import Link from "next/link";
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
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { Suspense } from "react";
import { ChartPanel, ChartLoading } from "@/components/ChartSection";
import { ProviderHealth } from "@/components/ProviderHealth";
import { FloatingTooltip } from "@/components/FloatingTooltip";
import { MethodRegionTabs } from "@/components/MethodRegionTabs";
import { RecentChallengesTable } from "@/components/RecentChallengesTable";
import { BucketLegend } from "@/components/BucketLegend";
import { fetchRecentChallenges, type RecentChallenge } from "@/lib/recentChallenges";
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
import { fetchProviderHealth, EMPTY_HEALTH } from "@/lib/health";
import { fetchConsensusRates, type ConsensusRate } from "@/lib/consensus";
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
  let consensusRates: ConsensusRate[] = [];
  let methodLat: MethodLatencyRow[] = [];
  let methodGeoLat: MethodGeoLatencyRow[] = [];
  let recentChallenges: RecentChallenge[] = [];
  let health = EMPTY_HEALTH;
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
    const [healthData, conRates, providers, ml, mgl, regionColdRaw, regionWarmRaw, recent] =
      await Promise.all([
        fetchProviderHealth(),
        fetchConsensusRates(),
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
        fetchRecentChallenges(20),
      ]);
    regionTableCold = regionColdRaw;
    regionTableWarm = regionWarmRaw;
    health = healthData;
    consensusRates = conRates;
    activeProviders = providers;
    methodLat = ml;
    methodGeoLat = mgl;
    recentChallenges = recent;
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

  const chartKey = [
    selectedGeo ?? "all",
    windowHours,
    connectionMode,
    selectedMethod,
    selectedProvider ?? "all",
  ].join("|");

  return (
    <div>
      <header className="max-w-[820px] pt-1">
        <span className="section-kicker">Performance</span>
        <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.025em] leading-[1.08] mt-2 mb-0 text-fg">
          Latency, by method &amp; region
        </h1>
        <p className="mt-3 text-[14.5px] leading-[1.6] text-fg2 max-w-[64ch]">
          A closer look behind the{" "}
          <Link href="/" className="text-accent hover:underline">
            Overview ranking
          </Link>
          : latency over time, per-method and per-region breakdowns, fleet health, and
          consensus checks. Filter by region, infra, time window, connection mode, and method.
        </p>
      </header>

      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, margin: "16px 0" }}>
          DB error: {error}
        </div>
      )}

      {/* Performance over time. */}
      <section className="pt-8">
        <div className="flex justify-between items-start gap-8 mb-[18px]">
          <div>
            <span className="section-kicker">01 · Performance over time</span>
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

      {/* Fleet health strip. */}
      <section className="home-extra">
        <div className="prov-section">
          <div className="prov-section-head">
            <span className="section-kicker">Fleet health · 15m</span>
          </div>
          <div className="mt-3">
            <ProviderHealth
              benchmarked={health.benchmarked}
              auditor={health.auditor}
              infra={health.infra}
              windowLabel="15m"
            />
          </div>
        </div>
      </section>

      {/* Recent challenges — live, sampled, all providers. */}
      <section className="home-extra">
        <div className="prov-section">
          <div className="prov-section-head">
            <span className="inline-flex items-center gap-1.5">
              <span className="section-kicker">Recent challenges · sampled</span>
              <BucketLegend />
            </span>
            <span className="prov-section-count">
              last {recentChallenges.length} ·{" "}
              <Link href="/challenges" className="section-link-arrow">
                view all &amp; filter
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M5 12h14M13 5l7 7-7 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            </span>
          </div>
          <div className="prov-table-wrap is-scroll">
            <RecentChallengesTable initial={recentChallenges} />
          </div>
        </div>
      </section>

      {/* Consensus integrity — daily breakdown of no-consensus, disputed, and
          auditor-unavailable rates. Sampled via consensus_log so totals are a
          slice of traffic, not the full population — ratios still meaningful. */}
      <section className="home-extra">
        <div className="prov-section">
          <div className="prov-section-head">
            <span className="section-kicker">Consensus integrity · 14d</span>
            <span className="prov-section-count">
              {health.auditor.consensus_accuracy_pct === null
                ? "finality re-verification: not yet sampled"
                : `finality-verified accuracy: ${health.auditor.consensus_accuracy_pct.toFixed(2)}% over ${health.auditor.consensus_audited_n.toLocaleString()} challenges`}
            </span>
          </div>
          {consensusRates.length === 0 ? (
            <p className="prov-empty">No consensus_log entries yet.</p>
          ) : (
            <div className="prov-table-wrap is-scroll">
              <table className="prov-table">
                <thead>
                  <tr>
                    <th>
                      <FloatingTooltip
                        title="Day"
                        trigger={
                          <span style={{ borderBottom: "1px dotted #555", cursor: "help" }}>Day</span>
                        }
                      >
                        <div className="font-medium mb-1.5">Day</div>
                        <div className="text-neutral-400">
                          Calendar day (UTC) the consensus decisions were finalized, most
                          recent first. The table covers the last 14 days.
                        </div>
                      </FloatingTooltip>
                    </th>
                    <th className="prov-num">
                      <FloatingTooltip
                        title="Sampled"
                        trigger={
                          <span style={{ borderBottom: "1px dotted #555", cursor: "help" }}>Sampled</span>
                        }
                      >
                        <div className="font-medium mb-1.5">Sampled</div>
                        <div className="text-neutral-400">
                          Consensus-log entries recorded that day. Logging is selective
                          (every disputed and no-consensus challenge plus a 1% sample of
                          clean archive traffic), so this is a <strong>slice</strong> of
                          all challenges, not the full population. The percentages stay
                          meaningful; the absolute counts do not.
                        </div>
                      </FloatingTooltip>
                    </th>
                    <th className="prov-num">
                      <FloatingTooltip
                        title="No-consensus"
                        trigger={
                          <span style={{ borderBottom: "1px dotted #555", cursor: "help" }}>No-consensus</span>
                        }
                      >
                        <div className="font-medium mb-1.5">No-consensus</div>
                        <div className="text-neutral-400">
                          The benchmarked-provider panel couldn&apos;t agree on a single
                          correct answer (decision = <code>ambiguous</code>). These
                          challenges are dropped from scoring. Lower is better.
                        </div>
                      </FloatingTooltip>
                    </th>
                    <th className="prov-num">
                      <FloatingTooltip
                        title="Disputed"
                        trigger={
                          <span style={{ borderBottom: "1px dotted #555", cursor: "help" }}>Disputed</span>
                        }
                      >
                        <div className="font-medium mb-1.5">Disputed</div>
                        <div className="text-neutral-400">
                          The panel agreed, but the independent auditor disagreed with the
                          panel&apos;s answer (auditor verdict = <code>disputed</code>).
                          These samples are dropped from scoring. Lower is better.
                        </div>
                      </FloatingTooltip>
                    </th>
                    <th className="prov-num">
                      <FloatingTooltip
                        title="Auditor down"
                        trigger={
                          <span style={{ borderBottom: "1px dotted #555", cursor: "help" }}>Auditor down</span>
                        }
                      >
                        <div className="font-medium mb-1.5">Auditor down</div>
                        <div className="text-neutral-400">
                          The panel agreed, but the auditor was unreachable so its answer
                          couldn&apos;t be cross-checked (auditor verdict ={" "}
                          <code>auditor_unavailable</code>). Samples are kept but flagged.
                          Lower is better.
                        </div>
                      </FloatingTooltip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {consensusRates.map((r) => (
                    <tr key={r.day}>
                      <td className="prov-amb-day">{r.day}</td>
                      <td className="prov-num">{r.total.toLocaleString()}</td>
                      <td className="prov-num">
                        {r.no_consensus.toLocaleString()}
                        {r.total > 0 && (
                          <span style={{ color: "#666", marginLeft: 4 }}>
                            ({((r.no_consensus / r.total) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td className="prov-num">
                        {r.disputed.toLocaleString()}
                        {r.total > 0 && (
                          <span style={{ color: "#666", marginLeft: 4 }}>
                            ({((r.disputed / r.total) * 100).toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td className="prov-num">{r.auditor_unavailable.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
