"use client";

/**
 * MobileFilterDisclosure — wraps the /performance chart filter groups so they
 * collapse behind a single "Filters" button on mobile, keeping the chart near
 * the top of the page instead of below ~11 stacked filter rows.
 *
 * Desktop (md+) is unchanged: the wrapper is `display: contents`, so it
 * dissolves and every filter group stays a DIRECT flex item of the parent
 * control bar (same wrapping row as before). The mobile header is `md:hidden`.
 *
 * Mobile: a compact header row shows the Filters toggle plus an always-inline
 * control (Connection Cold/Warm — the most-toggled one) so the primary view
 * mode is reachable without opening the panel. Tapping Filters reveals the full
 * group list with the app's standard grid-rows-[0fr]→[1fr] + fade animation
 * (same as the Overview "Customize" panel and the leaderboard row expand).
 *
 * Getting BOTH the desktop contents-dissolve and a mobile height animation from
 * one render (no duplicated interactive groups) needs `md:contents` on EVERY
 * level of the reveal wrapper: on mobile they form the grid → overflow-hidden →
 * flex-col structure the animation needs; on desktop all three collapse to
 * `display: contents` so the groups become direct flex items of the control bar
 * exactly as before (grid/overflow/opacity utilities are inert without a box).
 */

import { useState, type ReactNode } from "react";

export function MobileFilterDisclosure({
  /** Rendered inline in the mobile header, beside the Filters button (e.g. the
   *  Connection toggle). Hidden on desktop with the rest of the header. */
  inline,
  children,
}: {
  inline?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Compact mobile header — hidden on desktop. */}
      <div className="flex items-center gap-2 w-full md:hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-full border border-line2 px-3 py-[6px] font-geistmono text-[11px] uppercase tracking-[0.08em] text-fg2 transition-colors hover:text-fg hover:border-fg2 cursor-pointer shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3 5h18M6 12h12M10 19h4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          Filters
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className={"transition-transform " + (open ? "rotate-180" : "")}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {inline}
      </div>

      {/* Groups. Desktop: all three levels are `display: contents`, so the
          groups become direct flex items of the control bar (unchanged). Mobile:
          grid-rows reveal — outer grid animates the row track 0fr↔1fr, the
          overflow-hidden middle clips during the transition, the flex-col holds
          the stacked groups. */}
      <div
        className={
          "md:contents grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div
          className={
            "md:contents overflow-hidden transition-opacity duration-300 ease-out " +
            (open ? "opacity-100" : "opacity-0")
          }
        >
          <div className="md:contents flex w-full flex-col gap-3 pt-3">{children}</div>
        </div>
      </div>
    </>
  );
}
