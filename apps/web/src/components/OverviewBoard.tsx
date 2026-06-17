"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * OverviewBoard — the Overview page body: an intro row (blurb + stats, with a
 * brand hero visual of the current winner), a row of workload-preset chips over
 * the component-weight sliders, the blended-methods panel + scope line, and the
 * ranked leaderboard.
 *
 * The headline score is a WORKLOAD-PRESET blend: a provider's score is blended
 * across the preset's methods AND regions. Switching preset is a navigation
 * (?preset=) so the server refetches the right method/region cube; within a
 * preset the user tunes the component weights (sliders) and per-method weights
 * (MethodWeightPanel) client-side, re-ranking instantly. The board rows are
 * built ONCE here (buildPresetLeaderRows) and shared with the hero so #1 here
 * === #1 in the list below.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_REGION_WEIGHTS,
  type MethodWeights,
  type RegionWeights,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { GEO_REGIONS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import { brandColorFor, logoFor, animatedLogoFor } from "@/lib/providerColors";
import {
  SCORE_PRESETS,
  methodWeightsFor,
  presetById,
  type PresetId,
} from "@/lib/workloadPresets";
import { WINDOW_VALUES } from "@/lib/windows";
import { type ShareFilters } from "@/lib/share";
import { ShareButton } from "./ShareButton";
import { buildPresetLeaderRows, type MethodGeoRows } from "./leaderboardShared";
import { IndexLeaderboard, type MethodRegionLatency } from "./IndexLeaderboard";
import { MethodWeightPanel } from "./MethodWeightPanel";
import { ComponentWeightPanel } from "./ComponentWeightPanel";
import { RegionSelector } from "./RegionSelector";
import { LiveSampleCounter } from "./LiveSampleCounter";
import type { SampleCount } from "@/lib/sampleCount";

/** Distinct cloud infrastructures the benchmark vantages run on. */
const CLOUD_INFRA_COUNT = 4;

/** High-signal core methods shown in the expanded-row latency grid when a preset
 *  blends too many to list (e.g. Balanced = all 45). The SCORE still blends the
 *  full set; this only caps the per-method latency table. */
const CORE_GRID_METHODS: readonly Method[] = [
  "getTransaction",
  "getAccountInfo",
  "getTokenAccountsByOwner",
];
const GRID_METHOD_CAP = 8;

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
  cubeGeos,
  presetId,
  methodRegionLatency,
  sampleCount,
  methodCount,
}: {
  /** Per-(method, geo) preset cube — the client re-blends it on weight changes. */
  cube: MethodGeoRows[];
  /** All geos present in the cube (active geos) — the region selector's options. */
  cubeGeos: GeoRegion[];
  presetId: PresetId;
  methodRegionLatency: MethodRegionLatency;
  sampleCount: SampleCount;
  methodCount: number;
}) {
  const preset = presetById(presetId);
  // State seeds from the preset's defaults.
  const [componentWeights, setComponentWeights] = useState<ScoringWeights>(preset.weights);
  const [methodWeights, setMethodWeights] = useState<MethodWeights>(() => methodWeightsFor(preset));
  // Which regions count toward the score (+ their relative weights). Seeded from
  // the preset's region subset; the user can toggle any active region in/out.
  const [regionWeights, setRegionWeights] = useState<Partial<RegionWeights>>(
    () => ({ ...preset.regionWeights }),
  );

  // Reset client tuning to the new preset's defaults when the workload changes.
  // This replaces an old key={presetId} remount in page.tsx — remounting also
  // tore down the winner's hero logo <iframe>, reloading/replaying its animation
  // on every preset switch. Resetting in-place lets the subtree reconcile, so an
  // unchanged #1 provider keeps the same iframe (no reload). React's documented
  // "store info from previous render" pattern; runs during render, no flash.
  const [prevPresetId, setPrevPresetId] = useState(presetId);
  if (presetId !== prevPresetId) {
    setPrevPresetId(presetId);
    setComponentWeights(preset.weights);
    setMethodWeights(methodWeightsFor(preset));
    setRegionWeights({ ...preset.regionWeights });
  }

  // Region chips, in canonical order, restricted to geos with data.
  const regionOptions = GEO_REGIONS.filter((g) => cubeGeos.includes(g));
  const selectedRegionSet = new Set<string>(GEO_REGIONS.filter((g) => regionWeights[g] != null));

  // Expanded-row latency grid: the preset's methods when there are few, else the
  // core trio (so Balanced's 45-method blend doesn't render a 45-row table).
  const gridMethods =
    preset.methods.length > GRID_METHOD_CAP ? CORE_GRID_METHODS : preset.methods;
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

  // Reset the WHOLE preset: component weights, per-method weights, and the
  // region selection all return to the active preset's defaults.
  const resetAll = () => {
    setComponentWeights(preset.weights);
    setMethodWeights(methodWeightsFor(preset));
    setRegionWeights({ ...preset.regionWeights });
  };

  // The single preset blend — shared by the hero and the board.
  const presetRows = useMemo(
    () =>
      buildPresetLeaderRows(cube, {
        componentWeights,
        methodWeights,
        regionWeights,
      }),
    [cube, componentWeights, methodWeights, regionWeights],
  );

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

  const searchParams = useSearchParams();
  const windowParam = Number(searchParams.get("window"));
  const windowHours = WINDOW_VALUES.has(windowParam) ? windowParam : 24;
  const presetHref = (id: PresetId): Route => {
    const qs = new URLSearchParams();
    if (id !== "balanced") qs.set("preset", id);
    if (windowHours !== 24) qs.set("window", String(windowHours));
    const s = qs.toString();
    return (s ? `/?${s}` : "/") as Route;
  };

  const shareFilters: ShareFilters = {
    presetId,
    methods: preset.methods,
    methodWeights,
    regions: GEO_REGIONS.filter((g) => regionWeights[g] != null),
    weights: componentWeights,
    mode: "cold",
    windowHours,
  };

  return (
    <section className="relative pt-1 pb-2">
      {winner && <HeroLogo provider={winner} />}

      <div className="relative z-10 flex flex-col gap-4">
        {/* Intro — blurb + stats. */}
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

        {/* Control bar — preset chips (navigation) over the component-weight sliders. */}
        <div className="flex flex-col gap-2 py-3 border-y border-line">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="font-geistmono text-[10.5px] tracking-[0.14em] uppercase text-muted shrink-0 hidden sm:inline">
              Workload
            </span>
            <div className="flex flex-1 min-w-0 gap-1.5">
              {SCORE_PRESETS.map((pr) => {
                const active = presetId === pr.id;
                return (
                  <Link
                    key={pr.id}
                    href={presetHref(pr.id)}
                    scroll={false}
                    title={pr.caption}
                    aria-pressed={active}
                    className={
                      "flex-1 min-w-0 truncate text-center text-[11px] sm:text-[12px] font-medium px-2 sm:px-3.5 py-[7px] rounded-full border transition-colors hover:no-underline " +
                      (active
                        ? "bg-accent border-accent text-accentfg"
                        : "border-line2 text-fg2 hover:text-fg hover:border-fg2")
                    }
                  >
                    {pr.short}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Metric weights — inline sliders on desktop, dropdown on mobile.
              Reset restores the whole preset (component + method weights +
              region selection). */}
          <ComponentWeightPanel
            weights={componentWeights}
            onChange={(k, value) => setComponentWeights((w) => ({ ...w, [k]: value }))}
            onReset={resetAll}
          />
        </div>

      {/* Scope of the ranking — blended method set + regions (both tunable) +
          cold start + window, on one row. Regions are inline pills on desktop
          and a dropdown on mobile (see RegionSelector). Full matrix on
          /performance. Share sits at the right. */}
      <div className="mt-1.5 -mb-2 flex items-center gap-2 flex-wrap">
        <div className="flex items-center flex-wrap gap-x-1.5 font-geistmono text-[9.5px] sm:text-[10px] tracking-[0.12em] uppercase text-muted leading-snug">
          <MethodWeightPanel
            methods={preset.methods}
            weights={methodWeights}
            onChange={(m, value) => setMethodWeights((w) => ({ ...w, [m]: value }))}
            onReset={() => setMethodWeights(methodWeightsFor(preset))}
          />
          <span aria-hidden>·</span>
          <RegionSelector
            options={regionOptions}
            selected={selectedRegionSet}
            onToggle={toggleRegion}
          />
          <span>{" · cold start · last 24h"}</span>
        </div>
        <div className="ml-auto">
          <ShareButton filters={shareFilters} pagePath="/" />
        </div>
      </div>

      <IndexLeaderboard
        rows={presetRows}
        componentWeights={componentWeights}
        regionWeights={regionWeights}
        methodRegionLatency={methodRegionLatency}
        gridMethods={gridMethods}
        scoreMethodCount={preset.methods.length}
      />
      </div>
    </section>
  );
}
