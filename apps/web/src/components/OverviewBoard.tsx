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
import {
  DEFAULT_REGION_WEIGHTS,
  DEFAULT_WEIGHTS,
  blendRegionScores,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { GEO_REGIONS } from "@rpcbench/shared/types";
import { brandColorFor, logoFor, animatedLogoFor } from "@/lib/providerColors";
import { WORKLOAD_PRESETS, presetIdForWeights } from "@/lib/workloadPresets";
import { buildOverallLeaderRows, scorePerGeo } from "./leaderboardShared";
import { IndexLeaderboard, type RawGeoOutcome, type MethodRegionLatency } from "./IndexLeaderboard";
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
const AXIS_SHORT: Record<keyof ScoringWeights, string> = {
  latency: "Lat",
  winRate: "Win",
  reliability: "Rel",
  correctness: "Cor",
  freshness: "Fr",
};
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
}: {
  rawPerGeo: RawGeoOutcome[];
  methodRegionLatency: MethodRegionLatency;
  sampleCount: SampleCount;
  methodCount: number;
}) {
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [showWeights, setShowWeights] = useState(false);
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

  return (
    <section className="relative pt-1 pb-2">
      {/* Big animated winner logo bleeding from the top-right, fading to black
          behind the content. */}
      {winner && <HeroLogo provider={winner} />}

      <div className="relative z-10 flex flex-col gap-4">
        {/* Intro — blurb + stats. */}
        <div className="flex flex-col max-w-[640px]">
          <span className="section-kicker">Solana RPC Benchmark</span>
          <h1 className="text-[clamp(26px,4vw,38px)] font-semibold tracking-[-0.026em] leading-[1.08] mt-2 mb-0 text-fg">
            Find the best Solana RPC
          </h1>
          <p className="mt-3 mb-0 text-[15px] leading-[1.6] text-fg2">
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
              <span className="text-[22px] sm:text-[26px] font-semibold tabular-nums leading-none text-fg">{methodCount}</span>
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">RPC methods</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[22px] sm:text-[26px] font-semibold tabular-nums leading-none text-fg">{GEO_REGIONS.length}</span>
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">regions</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[22px] sm:text-[26px] font-semibold tabular-nums leading-none text-fg">{CLOUD_INFRA_COUNT}</span>
              <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">cloud infra</span>
            </div>
            <Link
              href="/methodology"
              className="group self-center inline-flex items-center gap-1.5 rounded-full border border-accent/40 px-3.5 py-[7px] text-[13px] font-medium text-accent transition-colors hover:bg-accent/10 hover:border-accent hover:no-underline"
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

        {/* Control bar — preset chips (always one line) + a toggle that reveals
            the manual weight sliders. */}
        <div className="flex flex-col gap-3 py-3 border-y border-line">
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
                    title={preset.label}
                    aria-pressed={active}
                    onClick={() => setWeights(preset.weights)}
                    className={
                      "flex-1 min-w-0 truncate text-center text-[12px] sm:text-[13px] font-medium px-2 sm:px-3.5 py-[7px] rounded-full border cursor-pointer transition-colors " +
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
            <button
              type="button"
              onClick={() => setShowWeights((s) => !s)}
              aria-expanded={showWeights}
              className="shrink-0 inline-flex items-center gap-1.5 font-geistmono text-[11px] text-muted bg-bg border border-line rounded-full px-3 py-[6px] cursor-pointer transition-colors hover:text-fg hover:border-line2"
            >
              Weights
              <span
                className={"text-[8px] transition-transform duration-200 " + (showWeights ? "rotate-180" : "")}
                aria-hidden="true"
              >
                ▼
              </span>
            </button>

            {/* Compact info — explains the leaderboard's scope without taking a row. */}
            <FloatingTooltip
              title="How providers are ranked"
              trigger={
                <span
                  className="shrink-0 inline-flex h-4 w-4 items-center justify-center cursor-help text-muted transition-colors hover:text-fg2"
                  aria-label="How are these ranked?"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M8 7.3v3.4" strokeLinecap="round" />
                    <circle cx="8" cy="5" r="0.6" fill="currentColor" stroke="none" />
                  </svg>
                </span>
              }
            >
              <div className="text-left font-normal normal-case tracking-normal leading-normal">
                <p className="text-neutral-300">
                  Ranked on <code>getTransaction</code>, cold start, last 24h, blended across
                  regions.
                </p>
                <p className="mt-1.5 text-neutral-400">
                  All methods, modes, and windows are on{" "}
                  <Link href="/performance" className="text-accent hover:underline">
                    Performance
                  </Link>
                  .
                </p>
              </div>
            </FloatingTooltip>
          </div>

          {/* Manual weights — hidden behind the toggle, slides open. */}
          <div
            className={
              "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none " +
              (showWeights ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
            }
          >
            <div className="overflow-hidden">
              <div className="flex items-center gap-x-4 gap-y-2 pt-1 flex-wrap">
                {AXIS_ORDER.map((k) => (
                  <label key={k} className="inline-flex items-center gap-1.5 font-geistmono text-[10.5px] text-fg2">
                    <FloatingTooltip
                      title={AXIS_LABEL[k]}
                      trigger={
                        <span className="text-muted uppercase tracking-[0.06em] text-[9px] cursor-help">
                          <span className="hidden sm:inline">{AXIS_LABEL[k]}</span>
                          <span className="sm:hidden inline-block w-[22px]">{AXIS_SHORT[k]}</span>
                        </span>
                      }
                    >
                      <p className="text-neutral-300">{AXIS_DESC[k]}</p>
                    </FloatingTooltip>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={weights[k] ?? 0}
                      onChange={(e) => setWeights((w) => ({ ...w, [k]: Number(e.target.value) }))}
                      className="w-[64px] h-1 accent-accent cursor-pointer"
                      aria-label={`${AXIS_LABEL[k]} weight`}
                    />
                    <span className="tabular-nums text-fg w-[26px] text-right">{(weights[k] ?? 0).toFixed(2)}</span>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => setWeights(DEFAULT_WEIGHTS)}
                  className="ml-auto shrink-0 font-geistmono text-[10.5px] text-muted bg-bg border border-line rounded-full px-2.5 py-1 cursor-pointer transition-colors hover:text-fg hover:border-line2 max-[860px]:ml-0"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        </div>

      <IndexLeaderboard
        rawPerGeo={rawPerGeo}
        selectedGeo={null}
        weights={weights}
        methodRegionLatency={methodRegionLatency}
      />
      </div>
    </section>
  );
}
