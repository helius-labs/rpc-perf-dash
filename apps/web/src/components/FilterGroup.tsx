import type { ReactNode } from "react";

/**
 * A labelled pill group for the chart filter bar. Used for the URL filters
 * (Region / Window / Method / RPC) and the chart-local toggles (Percentile /
 * Bin / Outliers) so they share one responsive layout.
 *
 * Desktop: label beside a wrapping pill row. Mobile: the group takes the full
 * row with a fixed-width label and a horizontally-scrollable pill strip, so a
 * group with many pills (e.g. 7 methods) stays one line instead of wrapping
 * into a tall wall.
 */
export function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0 max-md:w-full">
      <span className="font-geistmono text-[10.5px] text-muted uppercase tracking-[0.1em] shrink-0 max-md:w-[58px]">
        {label}
      </span>
      <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full min-w-0 flex-wrap max-md:flex-nowrap max-md:overflow-x-auto scrollbar-hide">
        {children}
      </div>
    </div>
  );
}
