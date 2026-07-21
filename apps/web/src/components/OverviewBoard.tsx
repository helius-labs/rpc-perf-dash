"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * OverviewBoard — the Overview page body: an intro row (blurb + stats, with a
 * brand hero visual of the current winner), the workload-preset chips + a
 * Methods select and a Customize dropdown, a scope line, and the ranked
 * leaderboard.
 *
 * The headline score is a WORKLOAD-PRESET blend: a provider's score is blended
 * across the preset's methods AND regions. Switching preset is a navigation
 * (?preset=) so the server refetches the right method/region cube; within a
 * preset the user tunes which methods are in the blend (Methods pill), the
 * component weights (Customize → sliders) and the region subset (Customize →
 * region buttons) client-side, re-ranking instantly. The board rows are built
 * ONCE here (buildPresetLeaderRows) and shared with the hero so #1 here === #1
 * in the list below.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_REGION_WEIGHTS,
  type RegionWeights,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { GEO_REGIONS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import { ALL_METHODS } from "@/lib/methods";
import { brandColorFor, logoFor, animatedLogoFor } from "@/lib/providerColors";
import {
  SCORE_PRESETS,
  equalMethodWeights,
  presetById,
  type PresetId,
} from "@/lib/workloadPresets";
import { WINDOWS, WINDOW_VALUES } from "@/lib/windows";
import { type ShareFilters } from "@/lib/share";
import { ShareButton } from "./ShareButton";
import { buildPresetLeaderRows, type MethodGeoRows } from "./leaderboardShared";
import { IndexLeaderboard, type MethodRegionLatency } from "./IndexLeaderboard";
import { ComponentWeightPanel } from "./ComponentWeightPanel";
import { RegionSelector } from "./RegionSelector";
import { MethodSelectPill } from "./MethodSelectPill";
import { LiveSampleCounter } from "./LiveSampleCounter";
import type { SampleCount } from "@/lib/sampleCount";

/** Shared pill styling for the preset chips, the Methods select, and the
 *  Customize trigger so they read as one control row. Fixed height (h-9) so a
 *  pill's width never changes its height. */
const PILL_BASE =
  "inline-flex items-center justify-center gap-1 sm:gap-1.5 h-9 px-2.5 sm:px-3.5 rounded-full border text-[11px] sm:text-[12px] font-medium transition-colors hover:no-underline cursor-pointer";
const PILL_ACTIVE = "bg-accent border-accent text-accentfg";
const PILL_IDLE = "border-line2 text-fg2 hover:text-fg hover:border-fg2";
/** Sizing for the Methods + Customize pills. On mobile they wrap to their own
 *  row (see the control bar) and split it evenly (flex-1) so their labels stay
 *  readable; on desktop they're fixed-width and narrower than the flex-1 preset
 *  pills, which grow to fill the rest of the row. */
const CONTROL_PILL_W = "flex-1 min-w-0 sm:flex-none sm:w-[116px]";

/** Distinct cloud infrastructures the benchmark vantages run on. */
const CLOUD_INFRA_COUNT = 4;

/** Max methods listed in the expanded-row latency grid. The SCORE still blends
 *  every selected method; this only caps the per-method latency table — extra
 *  selected methods are counted in the "Showing 6 of N" note but not rendered. */
const GRID_METHOD_CAP = 6;

/** All benchmarked methods, alphabetised — the Methods dropdown always lists the
 *  full set; presets only change which are pre-selected. */
const ALL_METHODS_SORTED: readonly Method[] = [...ALL_METHODS].sort((a, b) => a.localeCompare(b));

interface RankedProvider {
  id: string;
  name: string;
  color: string;
  logo: string | null;
  animated: string | null;
}

/** Large animated winner logo bleeding from the top-right, fading to black. */
function HeroLogo({ provider }: { provider: RankedProvider }) {
  const mask = "radial-gradient(circle at 64% 40%, #000 12%, rgba(0,0,0,0.32) 36%, transparent 60%)";
  return (
    <div
      className="pointer-events-none absolute top-0 right-0 z-0 w-[400px] h-[400px] max-[860px]:hidden"
      aria-hidden="true"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {provider.animated ? (
        <iframe
          key={provider.id}
          src={provider.animated}
          title=""
          aria-hidden="true"
          tabIndex={-1}
          scrolling="no"
          className="block w-full h-full border-0 bg-transparent pointer-events-none"
          style={{ colorScheme: "dark" }}
        />
      ) : provider.logo ? (
        <img key={provider.id} src={provider.logo} alt="" className="w-full h-full object-contain" />
      ) : null}
    </div>
  );
}

export function OverviewBoard({
  cube,
  presetId,
  methodRegionLatency,
  sampleCount,
  methodCount,
  embed = false,
}: {
  /** Per-(method, geo) preset cube — blended into the board with preset defaults. */
  cube: MethodGeoRows[];
  presetId: PresetId;
  methodRegionLatency: MethodRegionLatency;
  sampleCount: SampleCount;
  methodCount: number;
  /** Embed mode: hides the Share control (all filters stay interactive). Set by
   *  the /embed/leaderboard route; omitted everywhere else. */
  embed?: boolean;
}) {
  const preset = presetById(presetId);

  // Client tuning state — seeded from the active preset. Switching preset resets
  // these in place (NOT a key remount, which would reload the winner hero
  // iframe and replay its animation on every switch).
  const [componentWeights, setComponentWeights] = useState<ScoringWeights>(preset.weights);
  const [regionWeights, setRegionWeights] = useState<Partial<RegionWeights>>(
    () => ({ ...preset.regionWeights }),
  );
  const [selectedMethods, setSelectedMethods] = useState<Set<Method>>(
    () => new Set(preset.methods),
  );
  const [customizeOpen, setCustomizeOpen] = useState(false);

  // Which preset pill is shown active. Tracked in client state (not read off the
  // server `presetId` prop) so it flips the instant a pill is clicked, without
  // waiting for the URL navigation to round-trip. Re-synced from the prop below
  // whenever the server-resolved preset changes.
  const [selectedPresetId, setSelectedPresetId] = useState<PresetId>(presetId);

  const [prevPresetId, setPrevPresetId] = useState(presetId);
  if (presetId !== prevPresetId) {
    setPrevPresetId(presetId);
    setSelectedPresetId(presetId);
    setComponentWeights(preset.weights);
    setRegionWeights({ ...preset.regionWeights });
    setSelectedMethods(new Set(preset.methods));
  }

  // Region buttons' options — the geos present in the cube (active geos).
  const cubeGeos = useMemo(() => {
    const seen = new Set<GeoRegion>();
    for (const c of cube) seen.add(c.geo);
    return GEO_REGIONS.filter((g) => seen.has(g));
  }, [cube]);
  const selectedRegionSet = new Set<string>(GEO_REGIONS.filter((g) => regionWeights[g] != null));

  // Expanded-row latency grid: the selected methods when there are few, else the
  // core trio (so a 45-method blend doesn't render a 45-row table).
  // First GRID_METHOD_CAP selected methods (insertion order — so adding more
  // doesn't displace the ones already shown). scoreMethodCount carries the full
  // selected count, so the note reads "Showing 6 of N".
  const gridMethods = useMemo(() => [...selectedMethods].slice(0, GRID_METHOD_CAP), [selectedMethods]);

  const toggleRegion = (geo: GeoRegion) =>
    setRegionWeights((rw) => {
      const next = { ...rw };
      const selectedCount = GEO_REGIONS.filter((g) => next[g] != null).length;
      if (next[geo] != null) {
        if (selectedCount <= 1) return next; // keep at least one region
        delete next[geo];
      } else {
        next[geo] = DEFAULT_REGION_WEIGHTS[geo] ?? 0.1;
      }
      return next;
    });

  const toggleMethod = (m: Method) =>
    setSelectedMethods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        if (next.size <= 1) return next; // keep at least one method
        next.delete(m);
      } else {
        next.add(m);
      }
      return next;
    });
  const selectOnlyMethod = (m: Method) => setSelectedMethods(new Set([m]));
  const selectAllMethods = () => setSelectedMethods(new Set(ALL_METHODS_SORTED));

  // Apply a preset's defaults — component weights, region subset, and method
  // set. Used by the preset pills (so clicking one always re-applies it, even
  // when it's already the selected preset and the URL won't change) and Reset.
  const applyPreset = useCallback((p: (typeof SCORE_PRESETS)[number]) => {
    setSelectedPresetId(p.id);
    setComponentWeights(p.weights);
    setRegionWeights({ ...p.regionWeights });
    setSelectedMethods(new Set(p.methods));
  }, []);
  const resetAll = () => applyPreset(preset);

  // Preset switching updates the URL via the History API (see the pill onClick)
  // instead of a router navigation, so it doesn't re-run this force-dynamic page
  // and flash the loading skeleton. Back/forward fire popstate rather than a
  // click, so re-derive the board's preset from the URL here to keep them in sync.
  useEffect(() => {
    const sync = () => {
      const p = new URLSearchParams(window.location.search).get("preset");
      applyPreset(presetById(p ?? undefined));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [applyPreset]);

  // The single blend — shared by the hero and the board. Only the SELECTED
  // methods (equal-weighted) over the SELECTED regions are blended; the cube is
  // filtered to the chosen methods so deselected ones drop out entirely.
  const presetRows = useMemo(() => {
    const active = cube.filter((c) => selectedMethods.has(c.method as Method));
    return buildPresetLeaderRows(active, {
      componentWeights,
      methodWeights: equalMethodWeights([...selectedMethods]),
      regionWeights,
    });
  }, [cube, selectedMethods, componentWeights, regionWeights]);

  const winner = useMemo<RankedProvider | null>(() => {
    const top = presetRows.find((r) => r.coverage_ok && r.total > 0) ?? presetRows[0];
    if (!top) return null;
    return {
      id: top.provider_id,
      name: top.provider_name,
      color: brandColorFor(top.provider_id) ?? "var(--accent)",
      logo: logoFor(top.provider_id),
      animated: animatedLogoFor(top.provider_id),
    };
  }, [presetRows]);

  // Whether the current tuning still equals a given preset's defaults. Once the
  // user diverges (component weights, method set, or region set), no preset pill
  // is shown as active. Compared against the passed preset (not the server-prop
  // one) so a freshly-clicked pill matches instantly, pre-navigation.
  const tuningMatchesPreset = (p: (typeof SCORE_PRESETS)[number]): boolean => {
    const w = p.weights;
    const cw = componentWeights;
    if (
      cw.latency !== w.latency ||
      cw.winRate !== w.winRate ||
      cw.reliability !== w.reliability ||
      cw.correctness !== w.correctness ||
      cw.freshness !== w.freshness
    ) {
      return false;
    }
    if (selectedMethods.size !== p.methods.length) return false;
    for (const m of p.methods) if (!selectedMethods.has(m)) return false;
    const presetRegions = Object.keys(p.regionWeights);
    if (GEO_REGIONS.filter((g) => regionWeights[g] != null).length !== presetRegions.length) {
      return false;
    }
    for (const g of presetRegions) if (regionWeights[g as GeoRegion] == null) return false;
    return true;
  };

  const searchParams = useSearchParams();
  const windowParam = Number(searchParams.get("window"));
  const windowHours = WINDOW_VALUES.has(windowParam) ? windowParam : 24;
  const windowLabel = WINDOWS.find((w) => w.value === windowHours)?.label ?? `${windowHours}h`;
  const presetHref = (id: PresetId): Route => {
    const qs = new URLSearchParams();
    if (id !== "balanced") qs.set("preset", id);
    if (windowHours !== 24) qs.set("window", String(windowHours));
    const s = qs.toString();
    return (s ? `/?${s}` : "/") as Route;
  };
  // URL update for a preset click via the History API — query-relative (`?…` or
  // the bare pathname) so the current /benchmarks basePath is preserved; a
  // root-absolute "/?…" would resolve against the origin and drop it.
  const pushPresetUrl = (id: PresetId) => {
    const qs = new URLSearchParams();
    if (id !== "balanced") qs.set("preset", id);
    if (windowHours !== 24) qs.set("window", String(windowHours));
    const s = qs.toString();
    window.history.pushState(null, "", s ? `?${s}` : window.location.pathname);
  };

  const shareFilters: ShareFilters = {
    presetId: selectedPresetId,
    methods: [...selectedMethods],
    methodWeights: equalMethodWeights([...selectedMethods]),
    regions: GEO_REGIONS.filter((g) => regionWeights[g] != null),
    weights: componentWeights,
    mode: "cold",
    windowHours,
  };

  return (
    <section className="relative pt-1 pb-2">
      {!embed && winner && <HeroLogo provider={winner} />}

      <div className="relative z-10 flex flex-col gap-4">
        {/* Intro — blurb + stats. Hidden in embeds: a widget on someone else's
            page just needs the board, not the marketing hero / stat strip. */}
        {!embed && (
        <div className="flex flex-col max-w-[640px]">
          <h1 className="text-[clamp(24px,3.8vw,36px)] font-semibold tracking-[-0.026em] leading-[1.08] mt-2 mb-0 text-fg">
            Find the best Solana RPC
          </h1>
          <p className="mt-3 mb-0 text-[14px] leading-[1.6] text-fg2">
            A live, independent benchmark that ranks public Solana RPC providers by real-world
            speed and reliability. Pick the workload that matches yours, or expand a provider for
            the details.
          </p>
          <div className="mt-5 flex flex-wrap gap-x-6 sm:gap-x-10 gap-y-3">
            <div className="flex flex-col gap-1">
              <LiveSampleCounter initial={sampleCount} />
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">
                samples benchmarked
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[21px] sm:text-[24px] font-semibold tabular-nums leading-none text-fg">{methodCount}</span>
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">RPC methods</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[21px] sm:text-[24px] font-semibold tabular-nums leading-none text-fg">{GEO_REGIONS.length}</span>
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">regions</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[21px] sm:text-[24px] font-semibold tabular-nums leading-none text-fg">{CLOUD_INFRA_COUNT}</span>
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">cloud infra</span>
            </div>
            <Link
              href="/methodology"
              className="group self-center inline-flex items-center gap-1.5 rounded-full border border-accent/40 px-3.5 py-[7px] text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 hover:border-accent hover:no-underline"
            >
              How it works
              <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </div>
        </div>
        )}

        {/* Control bar — workload preset chips, a Methods select, and a
            Customize dropdown (region buttons + metric-weight sliders below). */}
        <div className="flex flex-col py-3 border-y border-line">
          {/* "Workload" label inline with the full-width pill row. */}
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="font-geistmono text-[10.5px] tracking-[0.14em] uppercase text-muted shrink-0 hidden sm:inline">
              Workload
            </span>
            {/* 3 flex-1 preset pills + Methods and Customize pills, all the same
                height. On mobile the row wraps: the preset group takes the full
                first line (basis-full) so each label stays readable, and the
                control group drops to a second line and splits it. On desktop
                (sm+) it's one row — presets grow, controls are fixed-width. */}
            <div className="flex flex-wrap sm:flex-nowrap items-stretch gap-1.5 flex-1 min-w-0">
              <div className="flex items-stretch gap-1.5 basis-full sm:basis-0 sm:flex-1 min-w-0 order-1">
              {SCORE_PRESETS.map((pr) => {
                // Active only when this is the selected preset AND the tuning is
                // still its defaults — customizing deactivates the pill. Both are
                // client-state-derived, so the active pill flips on click without
                // waiting for the URL navigation.
                const active = selectedPresetId === pr.id && tuningMatchesPreset(pr);
                return (
                  <Link
                    key={pr.id}
                    href={presetHref(pr.id)}
                    scroll={false}
                    onClick={(e) => {
                      // Let modified clicks (new tab/window) do a real navigation
                      // to the crawlable href; intercept plain clicks to re-blend
                      // client-side + update the URL without a server round-trip
                      // (which would flash loading.tsx). See pushPresetUrl.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                        return;
                      }
                      e.preventDefault();
                      applyPreset(pr);
                      pushPresetUrl(pr.id);
                    }}
                    title={pr.caption}
                    aria-pressed={active}
                    className={"flex-1 min-w-0 " + PILL_BASE + " " + (active ? PILL_ACTIVE : PILL_IDLE)}
                  >
                    <span className="truncate">{pr.short}</span>
                  </Link>
                );
              })}
              </div>
              {/* Control group — Methods + Customize. On mobile this wraps to the
                  second line (order-2) and splits it; on desktop it sits inline. */}
              <div className="flex items-stretch gap-1.5 basis-full sm:basis-auto sm:flex-none min-w-0 order-2">
              {/* Methods select — which methods are blended (preset-pill styling). */}
              <MethodSelectPill
                options={ALL_METHODS_SORTED}
                selected={selectedMethods}
                onToggle={toggleMethod}
                onOnly={selectOnlyMethod}
                onAll={selectAllMethods}
                className={CONTROL_PILL_W}
                triggerClass={"w-full " + PILL_BASE + " " + PILL_IDLE}
              />
              {/* Customize — toggles the region buttons + metric-weight sliders. */}
              <button
                type="button"
                onClick={() => setCustomizeOpen((o) => !o)}
                aria-expanded={customizeOpen}
                className={CONTROL_PILL_W + " " + PILL_BASE + " " + (customizeOpen ? PILL_ACTIVE : PILL_IDLE)}
              >
                <span className="truncate">Customize</span>
                <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" className={"shrink-0 " + (customizeOpen ? "rotate-180 transition-transform" : "transition-transform")}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              </div>
            </div>
          </div>

          {/* Expanded customize content — region buttons + metric-weight sliders.
              Same grid-rows reveal as the leaderboard provider-row expand. */}
          <div
            className={
              "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
              (customizeOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
            }
          >
            <div
              className={
                "overflow-hidden transition-opacity duration-300 ease-out " +
                (customizeOpen ? "opacity-100" : "opacity-0")
              }
            >
              {/* pb-2 leaves room for the slider thumbs (14px circle on a 6px
                  track overflows ~4px) so overflow-hidden doesn't clip them. */}
              <div className="flex flex-col gap-3 pt-3 pb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-muted shrink-0">
                    Regions
                  </span>
                  <RegionSelector options={cubeGeos} selected={selectedRegionSet} onToggle={toggleRegion} />
                </div>
                <ComponentWeightPanel
                  weights={componentWeights}
                  onChange={(k, value) => setComponentWeights((w) => ({ ...w, [k]: value }))}
                  onReset={resetAll}
                />
              </div>
            </div>
          </div>
        </div>

      {/* Scope of the ranking — the selected method/region span + cold start +
          window. Share sits at the right. */}
      <div className="-mt-2.5 -mb-3 flex items-center gap-2 flex-wrap">
        <div className="flex items-center flex-wrap gap-x-1.5 font-geistmono text-[9.5px] sm:text-[10px] tracking-[0.12em] uppercase text-muted leading-snug">
          <span>
            {selectedMethods.size} method{selectedMethods.size === 1 ? "" : "s"}
            {" · "}
            {selectedRegionSet.size} region{selectedRegionSet.size === 1 ? "" : "s"}
            {" · cold start · last "}
            {windowLabel}
          </span>
        </div>
        {!embed && (
          <div className="ml-auto">
            <ShareButton filters={shareFilters} pagePath="/" />
          </div>
        )}
      </div>

      <IndexLeaderboard
        rows={presetRows}
        componentWeights={componentWeights}
        regionWeights={regionWeights}
        methodRegionLatency={methodRegionLatency}
        gridMethods={gridMethods}
        scoreMethodCount={selectedMethods.size}
      />
      </div>
    </section>
  );
}
