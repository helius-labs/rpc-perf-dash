"use client";

/**
 * Client sends board — the /sends analogue of OverviewBoard, styled to MATCH it
 * exactly: the animated winner hero, a full-width workload-preset pill row + a
 * Customize dropdown (grid-rows reveal) housing weight sliders (identical to the
 * RPC ComponentWeightPanel), and a Share pill. Re-scores the board client-side
 * via scoreSends on every weight change (no server round-trip), so the ranking
 * and the winner hero update live.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  scoreSends,
  DEFAULT_SEND_WEIGHTS,
  type SendScoringWeights,
  type SendTargetMetrics,
} from "@rpcbench/shared/sendScoring";
import { blendRegionScalar, DEFAULT_REGION_WEIGHTS } from "@rpcbench/shared/scoring";
import { GEO_REGIONS, type GeoRegion } from "@rpcbench/shared/types";
import { animatedLogoFor, logoFor } from "@/lib/providerColors";
import { SendsLeaderboard } from "@/components/SendsLeaderboard";
import { SendsShareButton } from "@/components/SendsShareButton";
import { RegionSelector } from "@/components/RegionSelector";
import { FloatingTooltip } from "@/components/FloatingTooltip";
import type { SendBoardRow, SendGeoMetrics } from "@/lib/sends";

// Pill styling copied verbatim from OverviewBoard so the two control rows are
// visually identical (fixed h-9, same active/idle treatment, same control width).
const PILL_BASE =
  "inline-flex items-center justify-center gap-1 sm:gap-1.5 h-9 px-2.5 sm:px-3.5 rounded-full border text-[11px] sm:text-[12px] font-medium transition-colors hover:no-underline cursor-pointer";
const PILL_ACTIVE = "bg-accent border-accent text-accentfg";
const PILL_IDLE = "border-line2 text-fg2 hover:text-fg hover:border-fg2";
const CONTROL_PILL_W = "flex-1 min-w-0 sm:flex-none sm:w-[116px]";

interface SendPreset {
  id: string;
  label: string;
  caption: string;
  weights: SendScoringWeights;
}
const SEND_PRESETS: SendPreset[] = [
  { id: "balanced", label: "Balanced", caption: "Reliability-leaning blend of landing rate + slot latency.", weights: DEFAULT_SEND_WEIGHTS },
  { id: "reliability", label: "Reliability", caption: "Prioritize landing rate above all.", weights: { reliability: 0.8, latency: 0.2 } },
  { id: "latency", label: "Latency", caption: "Prioritize how fast the tx lands.", weights: { reliability: 0.3, latency: 0.7 } },
];

const AXIS_ORDER: ReadonlyArray<keyof SendScoringWeights> = ["reliability", "latency"];
const AXIS_LABEL: Record<keyof SendScoringWeights, string> = {
  reliability: "Reliability",
  latency: "Latency",
};
const AXIS_DESC: Record<keyof SendScoringWeights, string> = {
  reliability: "Share of sends that land on-chain (landed + reverted). Higher lands more.",
  latency: "How fast the transaction lands, measured in slots. Lower slot latency scores higher.",
};

function sliderBg(v: number): string {
  const pct = Math.round(v * 100);
  return `linear-gradient(to right, var(--accent) ${pct}%, rgb(255 255 255 / 0.1) ${pct}%)`;
}

/** 2-axis weight strip — identical markup/behaviour to ComponentWeightPanel. */
function SendWeightPanel({
  weights,
  onChange,
  onReset,
}: {
  weights: SendScoringWeights;
  onChange: (axis: keyof SendScoringWeights, value: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-end gap-x-4 sm:gap-x-5 gap-y-3 flex-wrap">
      {AXIS_ORDER.map((k) => {
        const v = weights[k] ?? 0;
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
              <span className="font-geistmono tabular-nums text-[10px] text-muted shrink-0">{v.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={v}
              onChange={(e) => onChange(k, Number(e.target.value))}
              className="weight-slider w-full cursor-pointer"
              style={{ background: sliderBg(v) }}
              aria-label={`${AXIS_LABEL[k]} weight`}
            />
          </div>
        );
      })}
      <button
        type="button"
        onClick={onReset}
        className="shrink-0 font-geistmono text-[10px] text-muted bg-bg border border-line2 rounded-full px-3.5 py-[6px] cursor-pointer transition-colors hover:text-fg hover:border-fg2"
      >
        Reset
      </button>
    </div>
  );
}

/** URL weight encoding — `sw=<r>-<l>` (percent ints). */
function encodeWeights(w: SendScoringWeights): string {
  return [w.reliability, w.latency].map((v) => Math.round(v * 100)).join("-");
}
function parseWeights(s: string | null): SendScoringWeights | null {
  if (!s) return null;
  const p = s.split("-").map(Number);
  if (p.length !== 2 || p.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { reliability: p[0]! / 100, latency: p[1]! / 100 };
}
function sameWeights(a: SendScoringWeights, b: SendScoringWeights): boolean {
  return a.reliability === b.reliability && a.latency === b.latency;
}

/** Animated winner hero (top-right, masked) — identical to OverviewBoard's. */
function HeroLogo({ id }: { id: string }) {
  const animated = animatedLogoFor(id);
  const logo = logoFor(id);
  if (!animated && !logo) return null;
  const mask = "radial-gradient(circle at 64% 40%, #000 12%, rgba(0,0,0,0.32) 36%, transparent 60%)";
  return (
    <div
      className="pointer-events-none absolute top-0 right-0 z-0 w-[400px] h-[400px] max-[860px]:hidden"
      aria-hidden="true"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {animated ? (
        <iframe src={animated} title="" aria-hidden="true" tabIndex={-1} scrolling="no" className="block w-full h-full border-0 bg-transparent pointer-events-none" style={{ colorScheme: "dark" }} />
      ) : (
        <img src={logo!} alt="" className="w-full h-full object-contain" />
      )}
    </div>
  );
}

export function SendsBoard({ rows }: { rows: SendBoardRow[] }) {
  const [weights, setWeights] = useState<SendScoringWeights>(DEFAULT_SEND_WEIGHTS);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  // Geos present in the board's per-geo data, in canonical order.
  const availableGeos = useMemo<GeoRegion[]>(
    () => GEO_REGIONS.filter((g) => rows.some((r) => g in r.per_geo)),
    [rows],
  );
  // Selected region subset (all present by default). null = not yet seeded.
  const [selectedRegions, setSelectedRegions] = useState<Set<string> | null>(null);
  const regionSet = selectedRegions ?? new Set<string>(availableGeos);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const w = parseWeights(params.get("sw"));
    if (w) setWeights(w);
    const sr = params.get("sr");
    if (sr) {
      const wanted = new Set(sr.split(",").map((s) => s.trim()).filter((g) => availableGeos.includes(g as GeoRegion)));
      if (wanted.size > 0) setSelectedRegions(wanted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scored = useMemo(() => {
    // Region-blend each target's per-geo metrics over the selected regions
    // (DEFAULT_REGION_WEIGHTS, renormalized over present geos) → the axes
    // scoreSends needs. Falls back to the all-region overall if a target has no
    // per-geo data in the selection.
    const blendMetric = (per: Record<string, SendGeoMetrics>, pick: (m: SendGeoMetrics) => number | null): number | null => {
      const map = new Map<GeoRegion, number>();
      for (const g of availableGeos) {
        if (!regionSet.has(g) || !(g in per)) continue;
        const v = pick(per[g]!);
        if (v != null) map.set(g, v);
      }
      return map.size > 0 ? blendRegionScalar(map, DEFAULT_REGION_WEIGHTS) : null;
    };
    const blended = rows.map((r) => {
      const land = blendMetric(r.per_geo, (m) => m.landing_rate) ?? r.landing_rate;
      const l50 = blendMetric(r.per_geo, (m) => m.slot_latency_p50) ?? r.slot_latency_p50;
      const l95 = blendMetric(r.per_geo, (m) => m.slot_latency_p95) ?? r.slot_latency_p95;
      return { ...r, landing_rate: land, slot_latency_p50: l50, slot_latency_p95: l95 };
    });
    const metrics: SendTargetMetrics[] = blended.map((r) => ({
      send_target: r.send_target,
      landing_rate: r.landing_rate,
      slot_latency_p50: r.slot_latency_p50 ?? 0,
      slot_latency_p95: r.slot_latency_p95 ?? 0,
    }));
    const byTarget = new Map(scoreSends(metrics, weights).map((s) => [s.send_target, s]));
    return blended
      .map((r) => {
        const s = byTarget.get(r.send_target);
        return s ? { ...r, total: s.total, reliability: s.reliability, latency: s.latency } : r;
      })
      .sort((a, b) => b.total - a.total)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }, [rows, weights, regionSet, availableGeos]);

  const toggleRegion = useCallback(
    (geo: GeoRegion) => {
      setSelectedRegions((prev) => {
        const cur = prev ?? new Set<string>(availableGeos);
        const next = new Set(cur);
        if (next.has(geo)) {
          if (next.size <= 1) return next; // keep at least one
          next.delete(geo);
        } else next.add(geo);
        const qs = new URLSearchParams(window.location.search);
        if (next.size === availableGeos.length) qs.delete("sr");
        else qs.set("sr", [...next].join(","));
        window.history.replaceState(null, "", qs.toString() ? `?${qs.toString()}` : window.location.pathname);
        return next;
      });
    },
    [availableGeos],
  );

  const activePreset = SEND_PRESETS.find((p) => sameWeights(p.weights, weights))?.id ?? null;

  const applyPreset = useCallback((p: SendPreset) => {
    setWeights(p.weights);
    const qs = new URLSearchParams(window.location.search);
    if (p.id === "balanced") qs.delete("sw");
    else qs.set("sw", encodeWeights(p.weights));
    const s = qs.toString();
    window.history.pushState(null, "", s ? `?${s}` : window.location.pathname);
  }, []);

  const setAxis = useCallback((key: keyof SendScoringWeights, value: number) => {
    setWeights((prev) => {
      const next = { ...prev, [key]: value };
      const qs = new URLSearchParams(window.location.search);
      qs.set("sw", encodeWeights(next));
      window.history.replaceState(null, "", `?${qs.toString()}`);
      return next;
    });
  }, []);

  const winner = scored[0];

  return (
    <section className="relative pt-1">
      {winner && <HeroLogo id={winner.send_target} />}

      <div className="relative z-10 flex flex-col gap-4">
        <div className="flex flex-col max-w-[820px]">
          <span className="section-kicker">Sends</span>
          <h1 className="mt-2.5 mb-0 text-[clamp(30px,5vw,44px)] font-semibold tracking-[-0.03em] leading-[1.05] text-fg">
            Transaction landing
          </h1>
          <p className="mt-4 text-[15.5px] leading-[1.6] text-fg2 max-w-[64ch]">
            Real transactions broadcast through every send path and scored against the chain —
            landing rate and slot latency. Pick the workload that matches yours,
            or expand a target for the details. See{" "}
            <a href="/methodology" className="underline">methodology</a>.
          </p>
        </div>

        {/* Control bar — full-width preset chips + a Customize dropdown. */}
        <div className="flex flex-col py-3 border-y border-line">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="font-geistmono text-[10.5px] tracking-[0.14em] uppercase text-muted shrink-0 hidden sm:inline">
              Workload
            </span>
            <div className="flex flex-wrap sm:flex-nowrap items-stretch gap-1.5 flex-1 min-w-0">
              <div className="flex items-stretch gap-1.5 basis-full sm:basis-0 sm:flex-1 min-w-0 order-1">
                {SEND_PRESETS.map((pr) => {
                  const active = activePreset === pr.id;
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      onClick={() => applyPreset(pr)}
                      title={pr.caption}
                      aria-pressed={active}
                      className={"flex-1 min-w-0 " + PILL_BASE + " " + (active ? PILL_ACTIVE : PILL_IDLE)}
                    >
                      <span className="truncate">{pr.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-stretch gap-1.5 basis-full sm:basis-auto sm:flex-none min-w-0 order-2">
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

          {/* Customize reveal — same grid-rows animation as the row expand. */}
          <div
            className={
              "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
              (customizeOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
            }
          >
            <div className={"overflow-hidden transition-opacity duration-300 ease-out " + (customizeOpen ? "opacity-100" : "opacity-0")}>
              <div className="flex flex-col gap-3 pt-3 pb-2">
                {availableGeos.length > 1 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-muted shrink-0">
                      Regions
                    </span>
                    <RegionSelector options={availableGeos} selected={regionSet} onToggle={toggleRegion} />
                  </div>
                )}
                <SendWeightPanel
                  weights={weights}
                  onChange={setAxis}
                  onReset={() => applyPreset(SEND_PRESETS[0]!)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Scope + Share — mirrors the RPC board's scope row. */}
        <div className="-mt-2.5 -mb-1 flex items-center justify-between gap-2 flex-wrap">
          <span className="font-geistmono text-[9.5px] sm:text-[10px] tracking-[0.12em] uppercase text-muted leading-snug">
            {scored.length} target{scored.length === 1 ? "" : "s"}
            {availableGeos.length > 1 ? ` · ${regionSet.size} region${regionSet.size === 1 ? "" : "s"}` : ""}
            {" · landing · last 24h"}
          </span>
          <SendsShareButton weights={weights} />
        </div>
      </div>

      {scored.length === 0 ? (
        <p className="mt-9 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
          No send samples yet. The board populates once the send lane is enabled and the
          confirmation service has classified landings.
        </p>
      ) : (
        <div className="relative z-10 mt-6">
          <SendsLeaderboard rows={scored} />
          <p className="mt-6 text-[12.5px] leading-[1.5] text-muted max-w-[68ch]">
            Ranked by score = {weights.reliability.toFixed(2)}·reliability (landing rate) +{" "}
            {weights.latency.toFixed(2)}·latency (slot). Tune the weights above; the ranking +
            winner update live.
          </p>

          <section className="mt-6 flex justify-end">
            <Link
              href={"/performance?board=sends" as Route}
              className="group inline-flex items-center gap-2 rounded-full border border-accent/40 px-4 py-[8px] text-[13px] font-medium text-accent transition-colors hover:bg-accent/10 hover:border-accent hover:no-underline"
            >
              Full performance details
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </section>
        </div>
      )}
    </section>
  );
}
