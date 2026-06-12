"use client";

/**
 * Mobile filter dropdowns for the leaderboard page. Replaces the desktop
 * pill rows on small viewports so users get a familiar tap-a-dropdown
 * pattern instead of a horizontally scrolling strip.
 *
 *  - <MobileSelectFilter> wraps a native <select> for single-select filters.
 *    On change it navigates to the matching href via Next's router.
 *  - <MobileMultiFilter> shows a summary button ("RPC: 2 selected") and opens
 *    a BottomSheet with a tappable list. Each row is a link to the toggled
 *    URL — matches the desktop pill toggle semantics.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BottomSheet } from "./BottomSheet";

export interface FilterOption {
  label: string;
  href: string;
  /** Stable identifier — used as the <option value=…> string. */
  key: string;
}

export function MobileSelectFilter({
  label,
  options,
  currentKey,
}: {
  label: string;
  options: FilterOption[];
  currentKey: string;
}) {
  const router = useRouter();
  const optionMap = new Map(options.map((o) => [o.key, o]));
  return (
    <label className="flex items-center gap-1.5 w-full text-[10px] text-neutral-400 min-w-0">
      <span className="uppercase tracking-wide text-neutral-500 shrink-0 w-10 truncate">
        {label}
      </span>
      <select
        value={currentKey}
        onChange={(e) => {
          const o = optionMap.get(e.target.value);
          if (o) {
            // Cast around Next's typedRoutes — the href is built from
            // `urlWith(params, …)` server-side, so it's not a statically
            // known route literal.
            router.push(o.href as Parameters<typeof router.push>[0]);
          }
        }}
        className="flex-1 min-w-0 bg-neutral-950 text-neutral-100 border border-neutral-700 rounded px-1.5 py-1 text-[12px]"
        style={{ fontFamily: "inherit" }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface MultiFilterItem {
  /** Provider id (or other stable id). */
  key: string;
  label: string;
  /** URL to navigate to in order to toggle this item's selection. */
  toggleHref: string;
  active: boolean;
}

export function MobileMultiFilter({
  label,
  allHref,
  items,
  selectedCount,
}: {
  label: string;
  /** Href that resets the selection to empty / "All". */
  allHref: string;
  items: MultiFilterItem[];
  selectedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    selectedCount === 0
      ? "All"
      : selectedCount === 1
        ? items.find((i) => i.active)?.label ?? `${selectedCount} selected`
        : `${selectedCount} selected`;
  return (
    <div className="flex items-center gap-1.5 w-full text-[10px] text-neutral-400 min-w-0">
      <span className="uppercase tracking-wide text-neutral-500 shrink-0 w-10 truncate">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex-1 min-w-0 bg-neutral-950 text-neutral-100 border border-neutral-700 rounded px-1.5 py-1 text-[12px] text-left flex items-center justify-between"
        style={{ fontFamily: "inherit" }}
      >
        <span className="truncate">{summary}</span>
        <span className="text-neutral-500 ml-1.5 shrink-0">▾</span>
      </button>
      <BottomSheet open={open} onOpenChange={setOpen} title={`${label} · select providers`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <a
            href={allHref}
            className={[
              "flex items-center gap-3 px-3 py-2 rounded border",
              selectedCount === 0
                ? "bg-[#0e2230] border-[#3aa3ff] text-[#7cc6ff]"
                : "bg-neutral-900 border-neutral-800 text-neutral-300",
            ].join(" ")}
            onClick={() => setOpen(false)}
          >
            <CheckIcon active={selectedCount === 0} />
            <span>All providers</span>
          </a>
          {items.map((i) => (
            <a
              key={i.key}
              href={i.toggleHref}
              className={[
                "flex items-center gap-3 px-3 py-2 rounded border",
                i.active
                  ? "bg-[#0e2230] border-[#3aa3ff] text-[#7cc6ff]"
                  : "bg-neutral-900 border-neutral-800 text-neutral-300",
              ].join(" ")}
              onClick={() => setOpen(false)}
            >
              <CheckIcon active={i.active} />
              <span>{i.label}</span>
            </a>
          ))}
        </div>
        <div className="text-neutral-500 text-[11px] mt-3">
          Each tap toggles one provider. Reopen this sheet to continue editing.
        </div>
      </BottomSheet>
    </div>
  );
}

function CheckIcon({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 18,
        height: 18,
        borderRadius: 3,
        border: `1px solid ${active ? "#3aa3ff" : "#444"}`,
        background: active ? "#0e2230" : "transparent",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        color: "#7cc6ff",
        flexShrink: 0,
      }}
    >
      {active ? "✓" : ""}
    </span>
  );
}
