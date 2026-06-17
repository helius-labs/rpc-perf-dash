"use client";

/**
 * RegionSelector — which regions count toward the Overview score. Responsive:
 *   - desktop (sm+): inline abbreviated toggle pills, so it sits on the scope
 *     row between the methods control and "cold start";
 *   - mobile: a compact "N regions" dropdown (like the methods panel), since the
 *     pills take too much width on a phone.
 * Both presentations share the parent's selection state + toggle handler.
 */

import { useEffect, useRef, useState } from "react";
import { GEO_REGION_LABELS, type GeoRegion } from "@rpcbench/shared/types";

/** Compact codes for the inline desktop pills (full names in the title/tooltip
 *  and the mobile dropdown). */
const SHORT_LABEL: Record<GeoRegion, string> = {
  "na-east": "NA-E",
  "na-west": "NA-W",
  "eu-central": "EU-C",
  "eu-west": "EU-W",
  "ap-northeast": "AP-NE",
  "ap-southeast": "AP-SE",
};

export function RegionSelector({
  options,
  selected,
  onToggle,
}: {
  options: readonly GeoRegion[];
  selected: ReadonlySet<string>;
  onToggle: (geo: GeoRegion) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

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
      {/* Desktop: inline abbreviated pills. */}
      <span className="hidden sm:inline-flex items-center gap-1 align-middle">
        {options.map((g) => {
          const on = selected.has(g);
          return (
            <button
              key={g}
              type="button"
              title={GEO_REGION_LABELS[g]}
              aria-pressed={on}
              onClick={() => onToggle(g)}
              className={
                "px-1.5 py-[2px] rounded text-[10px] tracking-normal border cursor-pointer transition-colors " +
                (on
                  ? "bg-accent/15 border-accent/60 text-fg"
                  : "border-line2 text-muted hover:text-fg hover:border-fg2")
              }
            >
              {SHORT_LABEL[g]}
            </button>
          );
        })}
      </span>

      {/* Mobile: dropdown trigger + popover. */}
      <span ref={ref} className="relative sm:hidden inline-block align-middle">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 font-geistmono text-[9.5px] tracking-[0.12em] uppercase text-accent cursor-pointer underline decoration-dotted decoration-accent/50 underline-offset-[3px]"
        >
          {selected.size} region{selected.size === 1 ? "" : "s"}
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"}>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-0 top-[140%] z-50 w-[210px] rounded-lg border border-line2 bg-bg shadow-xl py-1.5">
            {options.map((g) => {
              const on = selected.has(g);
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => onToggle(g)}
                  role="option"
                  aria-selected={on}
                  className={
                    "flex items-center gap-1.5 w-full text-left px-3 py-[6px] text-[12px] font-geistmono tracking-normal normal-case cursor-pointer transition-colors " +
                    (on ? "text-fg" : "text-fg2 hover:bg-line/40")
                  }
                >
                  <span aria-hidden className="w-3 shrink-0 text-center">{on ? "✓" : ""}</span>
                  <span className="truncate">{GEO_REGION_LABELS[g]}</span>
                </button>
              );
            })}
          </div>
        )}
      </span>
    </>
  );
}
