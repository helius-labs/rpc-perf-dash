"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * OverviewBoard — the Overview page body, ported from the rpc.bench design:
 * an intro row (blurb + stats on the left, a brand/decorative hero visual of
 * the current winner on the right), a row of workload-preset chips, and the
 * ranked leaderboard. Owns the scoring weights so the hero, the chips, and the
 * leaderboard all stay in sync (changing a preset re-ranks instantly and swaps
 * the hero to the new winner).
 *
 * The hero visual has four experimental variants, selected via the `?hero=`
 * URL param (watermark | spotlight | constellation | aurora) so they can be
 * reviewed side by side before settling on one.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_REGION_WEIGHTS,
  DEFAULT_WEIGHTS,
  blendRegionScores,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { GEO_REGIONS, type Method } from "@rpcbench/shared/types";
import { brandColorFor, logoFor, animatedLogoFor } from "@/lib/providerColors";
import { WORKLOAD_PRESETS, presetIdForWeights } from "@/lib/workloadPresets";
import { WINDOW_VALUES } from "@/lib/windows";
import { type ShareFilters } from "@/lib/share";
import { ShareButton } from "./ShareButton";
import { buildOverallLeaderRows, scorePerGeo } from "./leaderboardShared";
import { IndexLeaderboard, type RawGeoOutcome, type MethodRegionLatency } from "./IndexLeaderboard";
import { MethodFilter, type MethodOption } from "./MethodFilter";
import { LiveSampleCounter } from "./LiveSampleCounter";
import { FloatingTooltip } from "./FloatingTooltip";
import type { SampleCount } from "@/lib/sampleCount";

/** The five score axes, in display order — drives the weight sliders. */
const AXIS_ORDER: ReadonlyArray<keyof ScoringWeights> = [
  "latency",
  "winRate",
  "reliability",
  "correctness",
  "freshness",
];
/** Distinct cloud infrastructures the benchmark vantages run on (AWS, GCP,
 *  Cloudflare, Teraswitch/Latitude bare-metal). Surfaced as an intro stat. */
const CLOUD_INFRA_COUNT = 4;

const AXIS_LABEL: Record<keyof ScoringWeights, string> = {
  latency: "Latency",
  winRate: "Win rate",
  reliability: "Reliability",
  correctness: "Correctness",
  freshness: "Freshness",
};
/** One-line hover descriptions for each weight axis. */
const AXIS_DESC: Record<keyof ScoringWeights, string> = {
  latency: "How fast responses come back. Lower round-trip time scores higher.",
  winRate: "How often this provider returns first when racing the others on the same request.",
  reliability: "Share of requests that succeed without an error or timeout.",
  correctness: "Share of responses that match the verified consensus answer.",
  freshness: "How current the returned data is. Less lag behind the chain tip scores higher.",
};

interface RankedProvider {
  id: string;
  name: string;
  color: string;
  logo: string | null;
  animated: string | null;
}

/** Large animated winner logo that bleeds out from the top-right corner and
 *  fades to black behind the content via a radial mask — transparent canvas,
 *  dark color-scheme, non-interactive so it never blocks clicks. */
function HeroLogo({ provider }: { provider: RankedProvider }) {
  // Smaller fully-visible core + earlier fade so more of the mark dissolves into
  // black behind the content.
  const mask = "radial-gradient(circle at 64% 40%, #000 12%, rgba(0,0,0,0.32) 36%, transparent 60%)";
  return (
    <div
      className="pointer-events-none absolute top-0 right-0 z-0 w-[400px] h-[400px] max-[860px]:hidden"
      aria-hidden="true"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {provider.animated ? (
        <iframe
          src={provider.animated}
          title=""
          aria-hidden="true"
          tabIndex={-1}
          scrolling="no"
          className="block w-full h-full border-0 bg-transparent pointer-events-none"
          style={{ colorScheme: "dark" }}
        />
      ) : provider.logo ? (
        <img src={provider.logo} alt="" className="w-full h-full object-contain" />
      ) : null}
    </div>
  );
}

export function OverviewBoard({
  rawPerGeo,
  methodRegionLatency,
  sampleCount,
  methodCount,
  selectedMethod,
  methodOptions,
  gridMethods,
}: {
  rawPerGeo: RawGeoOutcome[];
  methodRegionLatency: MethodRegionLatency;
  sampleCount: SampleCount;
  methodCount: number;
  selectedMethod: string;
  methodOptions: MethodOption[];
  gridMethods: Method[];
}) {
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const activePresetId = presetIdForWeights(weights);

  // Full ranking under the active weighting — same overall blend the leaderboard
  // ranks by, so #1 here === #1 in the list below. Drives the hero logo.
  const ranked = useMemo<RankedProvider[]>(() => {
    if (rawPerGeo.length === 0) return [];
    const perGeo = rawPerGeo.map((o) => ({ ...o, scored: scorePerGeo(o, weights) }));
    const map = new Map(perGeo.map((o) => [o.geo, o.scored]));
    const blended = blendRegionScores(map, DEFAULT_REGION_WEIGHTS);
    return buildOverallLeaderRows(blended, perGeo).map((r) => ({
      id: r.provider_id,
      name: r.provider_name,
      color: brandColorFor(r.provider_id) ?? "var(--accent)",
      logo: logoFor(r.provider_id),
      animated: animatedLogoFor(r.provider_id),
    }));
  }, [rawPerGeo, weights]);

  const winner = ranked[0] ?? null;

  // Share-card filters mirror the Overview's fixed scope (Overall blend, cold
  // start) plus the live ranked method + tuned weights, so the generated card
  // matches the on-screen board. Window is read from the URL (?window=), the
  // only scope param the Overview varies; defaults to 24h.
  const searchParams = useSearchParams();
  const windowParam = Number(searchParams.get("window"));
  const windowHours = WINDOW_VALUES.has(windowParam) ? windowParam : 24;
  const shareFilters: ShareFilters = {
    method: selectedMethod as Method,
    region: "overall",
    mode: "cold",
    windowHours,
    weights,
  };

  return (
    <section className="relative pt-1 pb-2">
      {/* Big animated winner logo bleeding from the top-right, fading to black
          behind the content. */}
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
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-0.5"
              >
                <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </div>
        </div>

        {/* Control bar — preset chips (one line) over a compact, always-visible
            row of per-axis weight sliders. */}
        <div className="flex flex-col gap-2 py-3 border-y border-line">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="font-geistmono text-[10.5px] tracking-[0.14em] uppercase text-muted shrink-0 hidden sm:inline">
              Optimize for
            </span>
            <div className="flex flex-1 min-w-0 gap-1.5">
              {WORKLOAD_PRESETS.map((preset) => {
                const active = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={preset.caption}
                    aria-pressed={active}
                    onClick={() => setWeights(preset.weights)}
                    className={
                      "flex-1 min-w-0 truncate text-center text-[11px] sm:text-[12px] font-medium px-2 sm:px-3.5 py-[7px] rounded-full border cursor-pointer transition-colors " +
                      (active
                        ? "bg-accent border-accent text-white"
                        : "border-line2 text-fg2 hover:text-fg hover:border-fg2")
                    }
                  >
                    {preset.short}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Weights — always visible. A full-width strip of one mini slider
              per axis (label + value over the track) so it fills the row
              instead of leaving dead space, and stays short instead of pushing
              the leaderboard down. Accent fill (see .weight-slider in
              globals.css). */}
          <div className="flex items-end gap-x-4 sm:gap-x-5 gap-y-3 flex-wrap">
            {AXIS_ORDER.map((k) => {
              const v = weights[k] ?? 0;
              const pct = Math.round(v * 100);
              return (
                <div key={k} className="flex flex-col gap-1.5 flex-1 min-w-[104px]">
                  <div className="flex items-center justify-between gap-1 min-w-0">
                    <FloatingTooltip
                      title={AXIS_LABEL[k]}
                      trigger={
                        <span className="truncate font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted cursor-help underline decoration-dotted decoration-muted underline-offset-[3px]">
                          {AXIS_LABEL[k]}
                        </span>
                      }
                    >
                      <p className="text-neutral-300">{AXIS_DESC[k]}</p>
                    </FloatingTooltip>
                    <span className="font-geistmono tabular-nums text-[10px] text-muted shrink-0">
                      {v.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={v}
                    onChange={(e) => setWeights((w) => ({ ...w, [k]: Number(e.target.value) }))}
                    className="weight-slider w-full cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, var(--accent) ${pct}%, rgb(255 255 255 / 0.1) ${pct}%)`,
                    }}
                    aria-label={`${AXIS_LABEL[k]} weight`}
                  />
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setWeights(DEFAULT_WEIGHTS)}
              className="shrink-0 font-geistmono text-[10px] text-muted bg-bg border border-line2 rounded-full px-3.5 py-[6px] cursor-pointer transition-colors hover:text-fg hover:border-fg2"
            >
              Reset
            </button>
          </div>
        </div>

      {/* Scope of the ranking — stated in plain sight, not a tooltip. The
          method is switchable via the inline dropdown (?method=); the rest of
          the scope is fixed. Full matrix on /performance. The share control sits
          at the right end of this same row. */}
      <div className="mt-1.5 -mb-2 flex items-center gap-2 flex-wrap">
        <div className="flex items-center flex-wrap font-geistmono text-[9.5px] sm:text-[10px] tracking-[0.12em] uppercase text-muted leading-snug">
          <MethodFilter variant="inline" options={methodOptions} selected={selectedMethod} />
          <span>{" · cold start · last 24h · all regions"}</span>
        </div>
        <div className="ml-auto">
          <ShareButton filters={shareFilters} pagePath="/" />
        </div>
      </div>

      <IndexLeaderboard
        rawPerGeo={rawPerGeo}
        selectedGeo={null}
        weights={weights}
        methodRegionLatency={methodRegionLatency}
        gridMethods={gridMethods}
      />
      </div>
    </section>
  );
}
