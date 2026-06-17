"use client";

/**
 * ComponentWeightPanel — the five score-component weight sliders (latency, win
 * rate, reliability, correctness, freshness) as an inline strip with a Reset.
 * Controlled by the parent (OverviewBoard owns the weights state). It lives
 * inside the Overview's Customize disclosure, so it renders inline on every
 * viewport (no internal dropdown — that would clip inside the reveal's
 * overflow-hidden).
 */

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
  );
}
