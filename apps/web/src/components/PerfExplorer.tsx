"use client";

/**
 * Client owner of the /performance chart + scoreboard and their filter bar.
 *
 * Infra + Connection are React state (instant, no round-trip): switching them
 * swaps a pre-fetched/lazy-loaded data slice and syncs `wp`/`mode` to the URL
 * via history.replaceState (shareable, but no navigation). Region / Window /
 * Method stay `<Link>` navigations (they read different rollup slices), with
 * hrefs built from LIVE infra/mode state so a nav never drops the current
 * infra/connection selection.
 *
 * Data:
 * - `initialSlices`: both connection modes for the initial infra (server-fetched)
 *   → Connection toggle is instant from the first paint.
 * - other infras: fetched lazily from /api/perf-slice on first switch (both
 *   modes), memoised → instant thereafter. Never eager-all (single-infra cold
 *   queries are the slow ones).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
// Import from leaf subpaths (not the barrel) — the barrel pulls in timing.ts →
// node:tls, which can't be bundled into a "use client" component.
import { GEO_REGION_LABELS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import { WORKER_PROVIDER_LABELS } from "@rpcbench/shared/providers";
import type { MethodWeights } from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { apiPath } from "@/lib/basePath";
import { buildPageUrl } from "@/lib/apiParams";
import type { PerfSlice } from "@/lib/perfSlice";
import { FilterGroup } from "./FilterGroup";
import { MobileFilterDisclosure } from "./MobileFilterDisclosure";
import { FilterPill } from "./FilterPill";
import { MethodFilter } from "./MethodFilter";
import { LatencyChart } from "./LatencyChart";
import { PerfScoreboard } from "./PerfScoreboard";
import { ChartSkeleton } from "./ChartSkeleton";

type Mode = "cold" | "warm";
type ModeSlices = { cold: PerfSlice; warm: PerfSlice };

// Matches LatencyChart's control-bar layout so the loading state's filter bar
// lines up with the real one.
const BAR_CLS =
  "flex flex-col py-3 border-y border-line mb-4 md:flex-row md:flex-wrap md:items-center md:gap-x-[22px] md:gap-y-3.5 md:py-3.5";

const PILL_BASE =
  "inline-block border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] transition-colors";

/** Client toggle styled like FilterPill's active/inactive pill (no navigation). */
function TogglePill({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span
        title={title}
        aria-disabled="true"
        className={`${PILL_BASE} text-fg2 opacity-30 cursor-not-allowed select-none`}
      >
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`${PILL_BASE} cursor-pointer ${active ? "bg-fg text-bg" : "bg-transparent text-fg2 hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

const keyOf = (infra: string | null) => infra ?? "all";

export function PerfExplorer({
  initialInfra,
  initialMode,
  initialSlices,
  baseParams,
  selectedGeos,
  activeGeos,
  activeProviders,
  windowHours,
  selectedMethods,
  selectedMethod,
  selectedMethodSet,
  geosByInfra,
  infraByGeo,
  mwOverrides,
  shareRegions,
  scoreboardKey,
  initialBenchmarked,
}: {
  initialInfra: string | null;
  initialMode: Mode;
  initialSlices: ModeSlices;
  /** Server searchParams, for building nav hrefs (wp/mode overridden live). */
  baseParams: Record<string, string | undefined>;
  selectedGeos: GeoRegion[];
  activeGeos: GeoRegion[];
  activeProviders: string[];
  windowHours: number;
  selectedMethods: Method[];
  selectedMethod: Method;
  selectedMethodSet: string[];
  geosByInfra: Record<string, GeoRegion[]>;
  infraByGeo: Record<string, string[]>;
  mwOverrides: MethodWeights;
  shareRegions: GeoRegion[];
  scoreboardKey: string;
  initialBenchmarked: string[];
}) {
  const router = useRouter();
  const [infra, setInfra] = useState<string | null>(initialInfra);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [slices, setSlices] = useState<Record<string, ModeSlices>>({
    [keyOf(initialInfra)]: initialSlices,
  });
  // Infras whose lazy fetch is in flight (dedupe rapid clicks) and infras whose
  // fetch failed (so we show an error instead of an endless skeleton). Loading
  // state is derived from cache presence for the CURRENT infra, so out-of-order
  // fetch resolutions from rapid clicks never display the wrong slice.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [errored, setErrored] = useState<Set<string>>(new Set());

  const methodSetForList = useMemo(() => new Set(selectedMethodSet), [selectedMethodSet]);

  const syncUrl = useCallback((nextInfra: string | null, nextMode: Mode) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nextInfra) url.searchParams.set("wp", nextInfra);
    else url.searchParams.delete("wp");
    if (nextMode === "warm") url.searchParams.set("mode", "warm");
    else url.searchParams.delete("mode");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const selectMode = useCallback(
    (m: Mode) => {
      setMode(m);
      syncUrl(infra, m);
    },
    [infra, syncUrl],
  );

  // Fetch an infra's slice (both modes) if not already cached / in flight.
  // Keyed by infra, so a resolution always lands in the right cache slot no
  // matter how many times the user clicked in between.
  const loadInfra = useCallback(
    async (target: string | null) => {
      const k = keyOf(target);
      if (slices[k] || inFlightRef.current.has(k)) return;
      inFlightRef.current.add(k);
      setErrored((e) => {
        if (!e.has(k)) return e;
        const n = new Set(e);
        n.delete(k);
        return n;
      });
      try {
        const qs = new URLSearchParams();
        if (target) qs.set("infra", target);
        if (selectedGeos.length > 0) qs.set("geos", selectedGeos.join(","));
        qs.set("methods", selectedMethods.join(","));
        qs.set("window", String(windowHours));
        const r = await fetch(apiPath(`/api/perf-slice?${qs.toString()}`));
        if (!r.ok) throw new Error(`perf-slice ${r.status}`);
        const data = (await r.json()) as ModeSlices;
        setSlices((s) => ({ ...s, [k]: data }));
      } catch (err) {
        console.error("[PerfExplorer] slice fetch failed", err);
        setErrored((e) => new Set(e).add(k));
      } finally {
        inFlightRef.current.delete(k);
      }
    },
    [slices, selectedGeos, selectedMethods, windowHours],
  );

  const selectInfra = useCallback(
    (next: string | null) => {
      setInfra(next);
      syncUrl(next, mode);
      void loadInfra(next);
    },
    [mode, syncUrl, loadInfra],
  );

  // Display state derives from cache presence for the CURRENTLY selected infra —
  // never from a stale loading flag, so rapid switches always resolve correctly.
  const slice = slices[keyOf(infra)]?.[mode];
  const isErrored = !slice && errored.has(keyOf(infra));
  const isLoading = !slice && !isErrored;

  // ---- filter bar (built from live infra/mode so nav hrefs never go stale) ----
  const liveParams: Record<string, string | undefined> = {
    ...baseParams,
    wp: infra ?? undefined,
    mode: mode === "warm" ? "warm" : undefined,
  };
  const href = (override: Record<string, string | null>): string =>
    buildPageUrl("/performance", liveParams, override);

  const selectedGeoSet = new Set(selectedGeos);
  const regionDisabled = (g: GeoRegion): boolean =>
    infra !== null && !selectedGeoSet.has(g) && !(geosByInfra[infra]?.includes(g) ?? false);
  const infraDisabled = (p: string): boolean =>
    selectedGeos.length > 0 &&
    p !== infra &&
    !selectedGeos.some((g) => infraByGeo[g]?.includes(p) ?? false);

  const filters = (
    <>
      <FilterGroup label="Region">
        <FilterPill active={selectedGeos.length === 0} href={href({ regions: null })}>
          All
        </FilterPill>
        {activeGeos.map((g) => {
          const inSel = selectedGeoSet.has(g);
          const next = inSel ? selectedGeos.filter((x) => x !== g) : [...selectedGeos, g];
          return (
            <FilterPill
              key={g}
              active={inSel}
              href={href({ regions: next.length > 0 ? next.join(",") : null })}
              disabled={regionDisabled(g)}
              title={
                regionDisabled(g)
                  ? `No ${WORKER_PROVIDER_LABELS[infra!] ?? infra} workers in ${GEO_REGION_LABELS[g]}`
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
          <TogglePill active={infra === null} onClick={() => void selectInfra(null)}>
            All
          </TogglePill>
          {activeProviders.map((p) => (
            <TogglePill
              key={p}
              active={p === infra}
              disabled={infraDisabled(p)}
              title={
                infraDisabled(p)
                  ? `No ${WORKER_PROVIDER_LABELS[p] ?? p} workers in the selected regions`
                  : undefined
              }
              onClick={() => void selectInfra(p)}
            >
              {WORKER_PROVIDER_LABELS[p] ?? p}
            </TogglePill>
          ))}
        </FilterGroup>
      )}
      <FilterGroup label="Window">
        {WINDOWS.map((w) => (
          <FilterPill key={w.value} active={w.value === windowHours} href={href({ window: String(w.value) })}>
            {w.label}
          </FilterPill>
        ))}
      </FilterGroup>
      {/* Desktop Connection group in its normal position. On mobile it's hidden
          here and shown inline in the Filters-bar header instead (see
          connectionInline) so Cold/Warm stays reachable without opening the
          panel. `md:contents` keeps the group a direct flex item on desktop. */}
      <div className="max-md:hidden md:contents">
        <FilterGroup label="Connection">
          <TogglePill active={mode === "cold"} onClick={() => selectMode("cold")}>
            Cold
          </TogglePill>
          <TogglePill active={mode === "warm"} onClick={() => selectMode("warm")}>
            Warm
          </TogglePill>
        </FilterGroup>
      </div>
      <FilterGroup label="Method">
        <MethodFilter
          multi
          selectedSet={methodSetForList}
          options={[...ALL_METHODS]
            .sort((a, b) => a.localeCompare(b))
            .map((m) => {
              const next = methodSetForList.has(m)
                ? selectedMethods.filter((x) => x !== m)
                : [...selectedMethods, m];
              const list = next.length > 0 ? next : selectedMethods;
              return {
                method: m,
                href: href({ method: m }),
                toggleHref: href({ method: list.join(",") }),
              };
            })}
          selected={selectedMethod}
        />
      </FilterGroup>
    </>
  );

  // The Connection toggle, rendered inline in the mobile Filters-bar header
  // (the desktop copy lives inside `filters`, mobile-hidden). Bare pill group —
  // no "Connection" label — to stay compact beside the Filters button and the
  // export button that follows it in the header.
  const connectionInline = (
    <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full shrink-0">
      <TogglePill active={mode === "cold"} onClick={() => selectMode("cold")}>
        Cold
      </TogglePill>
      <TogglePill active={mode === "warm"} onClick={() => selectMode("warm")}>
        Warm
      </TogglePill>
    </div>
  );

  const scoreboardProps = slice
    ? slice.scoreboard.kind === "cube"
      ? { cube: slice.scoreboard.cube }
      : { prebuiltRows: slice.scoreboard.prebuiltRows }
    : undefined;

  return (
    <>
      <header className="pt-1 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-x-12 gap-y-6">
        <div className="max-w-[560px]">
          <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.025em] leading-[1.08] mt-2 mb-0 text-fg">
            Latency, by method &amp; region
          </h1>
          <p className="mt-3 text-[14.5px] leading-[1.6] text-fg2">
            A closer look behind the{" "}
            <Link href={"/" as Route} className="text-accent hover:underline">
              Overview ranking
            </Link>
            : latency over time plus per-method and per-region breakdowns. Filter by
            region, infra, time window, connection mode, and method.
          </p>
        </div>
        <div className="w-full lg:w-[360px] shrink-0 lg:pt-3">
          {isLoading ? (
            <div
              className="w-full h-[200px] rounded-lg border border-line bg-[color-mix(in_srgb,var(--text)_3%,transparent)] animate-pulse"
              aria-hidden="true"
            />
          ) : isErrored ? (
            <div className="badge bad" style={{ display: "block", padding: 12 }} role="alert">
              Scoreboard unavailable — try another infra.
            </div>
          ) : (
            <PerfScoreboard
              key={scoreboardKey}
              {...(scoreboardProps ?? {})}
              selectedMethods={selectedMethods}
              regions={shareRegions}
              mwOverrides={mwOverrides}
              windowHours={windowHours}
              mode={mode}
              infra={infra ?? undefined}
            />
          )}
        </div>
      </header>

      <section className="pt-1">
        <div className="flex justify-between items-start gap-8 mb-3">
          <h2 className="text-[26px] font-medium tracking-[-0.022em] mt-0 mb-0">
            Performance over time
          </h2>
        </div>
        {isLoading ? (
          // Loading a new infra's slice: keep the (interactive) filter bar and
          // show a skeleton plot — the same "loading chart" look as a first load,
          // rather than dimming the existing chart.
          <div>
            <div className={BAR_CLS}>
              <MobileFilterDisclosure inline={connectionInline}>{filters}</MobileFilterDisclosure>
            </div>
            <ChartSkeleton />
          </div>
        ) : isErrored ? (
          <div>
            <div className={BAR_CLS}>
              <MobileFilterDisclosure inline={connectionInline}>{filters}</MobileFilterDisclosure>
            </div>
            <div className="badge bad" style={{ display: "block", padding: 12 }} role="alert">
              Chart data unavailable — try again or pick another infra.
            </div>
          </div>
        ) : (
          <LatencyChart
            series={slice!.series}
            scoreSeries={slice!.scoreSeries}
            windowHours={windowHours}
            connectionMode={mode}
            filters={filters}
            mobileInlineFilter={connectionInline}
            showRpcFilter
            initialBenchmarked={initialBenchmarked}
            method={selectedMethods.length === 1 ? selectedMethods[0] : undefined}
            selectedGeos={selectedGeos}
            workerProvider={infra ?? undefined}
          />
        )}
      </section>
    </>
  );
}
