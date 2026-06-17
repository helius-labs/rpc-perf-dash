"use client";

/**
 * ComponentWeightPanel — the five score-component weight sliders (latency, win
 * rate, reliability, correctness, freshness). Responsive:
 *   - desktop (sm+): the full inline slider strip;
 *   - mobile: a compact "Metric weights" dropdown (like the methods/regions
 *     controls), since five labelled sliders take too much vertical space on a
 *     phone.
 * Controlled by the parent (OverviewBoard owns the weights state).
 */

import { useEffect, useRef, useState } from "react";
import type { ScoringWeights } from "@rpcbench/shared/scoring";
import { FloatingTooltip } from "./FloatingTooltip";

const AXIS_ORDER: ReadonlyArray<keyof ScoringWeights> = [
  "latency",
  "winRate",
  "reliability",
  "correctness",
  "freshness",
];

const AXIS_LABEL: Record<keyof ScoringWeights, string> = {
  latency: "Latency",
  winRate: "Win rate",
  reliability: "Reliability",
  correctness: "Correctness",
  freshness: "Freshness",
};

const AXIS_DESC: Record<keyof ScoringWeights, string> = {
  latency: "How fast responses come back. Lower round-trip time scores higher.",
  winRate: "How often this provider returns first when racing the others on the same request.",
  reliability: "Share of requests that succeed without an error or timeout.",
  correctness: "Share of responses that match the verified consensus answer.",
  freshness: "How current the returned data is. Less lag behind the chain tip scores higher.",
};

function sliderBg(v: number): string {
  const pct = Math.round(v * 100);
  return `linear-gradient(to right, var(--accent) ${pct}%, rgb(255 255 255 / 0.1) ${pct}%)`;
}

export function ComponentWeightPanel({
  weights,
  onChange,
  onReset,
}: {
  weights: ScoringWeights;
  onChange: (axis: keyof ScoringWeights, value: number) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <>
      {/* Desktop: inline slider strip. */}
      <div className="hidden sm:flex items-end gap-x-4 sm:gap-x-5 gap-y-3 flex-wrap">
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

      {/* Mobile: dropdown trigger on the left, Reset pinned right on the same
          row (NOT inside the popover). */}
      <div ref={ref} className="relative sm:hidden flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 font-geistmono text-[10px] tracking-[0.12em] uppercase text-accent cursor-pointer underline decoration-dotted decoration-accent/50 underline-offset-[3px]"
        >
          Metric weights
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"}>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 font-geistmono text-[10px] text-muted bg-bg border border-line2 rounded-full px-3 py-[5px] cursor-pointer transition-colors hover:text-fg hover:border-fg2"
        >
          Reset
        </button>
        {open && (
          <div className="absolute left-0 top-[140%] z-50 w-[260px] rounded-lg border border-line2 bg-bg shadow-xl">
            <div className="px-3 py-2 flex flex-col gap-2.5">
              {AXIS_ORDER.map((k) => {
                const v = weights[k] ?? 0;
                return (
                  <div key={k} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">
                        {AXIS_LABEL[k]}
                      </span>
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
                      onChange={(e) => onChange(k, Number(e.target.value))}
                      className="weight-slider w-full cursor-pointer"
                      style={{ background: sliderBg(v) }}
                      aria-label={`${AXIS_LABEL[k]} weight`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
