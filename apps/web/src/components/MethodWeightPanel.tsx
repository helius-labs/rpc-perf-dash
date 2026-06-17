"use client";

/**
 * MethodWeightPanel — the Overview's "what's in the blend" control. Shows the
 * count of methods in the active preset and, on click, a fixed-height scrollable
 * popover listing every blended method with a mini weight slider. Replaces the
 * old single-method dropdown: the headline score is now a method-blend, so this
 * panel both *discloses* the method set (transparency) and lets the user tune
 * per-method weights on top of the preset.
 */

import { useEffect, useRef, useState } from "react";
import type { Method } from "@rpcbench/shared/types";
import type { MethodWeights } from "@rpcbench/shared/scoring";

export function MethodWeightPanel({
  methods,
  weights,
  onChange,
  onReset,
}: {
  methods: readonly Method[];
  /** Current per-method weights (controlled by the parent). */
  weights: MethodWeights;
  onChange: (method: string, value: number) => void;
  /** Reset every method weight back to the preset's defaults. */
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

  const total = Object.values(weights).reduce((a, w) => a + Math.max(0, w), 0);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 font-geistmono text-[9.5px] sm:text-[10px] tracking-[0.12em] uppercase text-accent cursor-pointer underline decoration-dotted decoration-accent/50 underline-offset-[3px] hover:text-accent"
      >
        {methods.length} method{methods.length === 1 ? "" : "s"}
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-[140%] z-50 w-[280px] rounded-lg border border-line2 bg-bg shadow-xl">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line">
            <span className="font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">
              Methods in the blend
            </span>
            <button
              type="button"
              onClick={onReset}
              className="font-geistmono text-[9.5px] text-muted hover:text-fg cursor-pointer"
            >
              Reset
            </button>
          </div>
          <div className="max-h-[260px] overflow-y-auto px-3 py-2 flex flex-col gap-2">
            {methods.map((m) => {
              const v = weights[m] ?? 0;
              const share = total > 0 ? v / total : 0;
              const pct = Math.round(share * 100);
              return (
                <div key={m} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <code className="truncate text-[11px] text-fg2">{m}</code>
                    <span className="font-geistmono tabular-nums text-[10px] text-muted shrink-0">
                      {pct}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={v}
                    onChange={(e) => onChange(m, Number(e.target.value))}
                    className="weight-slider w-full cursor-pointer"
                    style={{
                      background: `linear-gradient(to right, var(--accent) ${Math.round(v * 100)}%, rgb(255 255 255 / 0.1) ${Math.round(v * 100)}%)`,
                    }}
                    aria-label={`${m} weight`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
