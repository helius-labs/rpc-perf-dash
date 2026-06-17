"use client";

/**
 * RegionSelector — which regions count toward the Overview score, as inline
 * abbreviated toggle pills. Lives inside the Overview's Customize disclosure, so
 * it renders inline on every viewport (no internal dropdown — that would clip
 * inside the reveal's overflow-hidden). Selection state + toggle come from the
 * parent.
 */

import { GEO_REGION_LABELS, type GeoRegion } from "@rpcbench/shared/types";

/** Compact codes for the pills (full names in the title attribute). */
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
  return (
    <span className="inline-flex items-center gap-1 align-middle flex-wrap">
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
  );
}
