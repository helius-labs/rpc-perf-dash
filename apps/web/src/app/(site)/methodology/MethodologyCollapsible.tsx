"use client";

/**
 * Collapsible methodology section using the same grid-rows slide + fade reveal
 * as the Overview (leaderboard expand, weights toggle). Replaces a native
 * <details> so the open/close is animated rather than instant.
 */

import { useState, type ReactNode } from "react";

export function MethodologyCollapsible({
  title,
  slug,
  children,
}: {
  title: string;
  slug: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md-collapsible">
      <button
        type="button"
        id={slug}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="md-summary w-full bg-transparent"
      >
        {title}
        {/* Chevron (matches the Overview's collapsible toggles), not a triangle. */}
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          aria-hidden="true"
          className={"ml-auto shrink-0 text-muted transition-transform " + (open ? "rotate-180" : "")}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div
        className={
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div
          className={
            "overflow-hidden transition-opacity duration-300 ease-out " +
            (open ? "opacity-100" : "opacity-0")
          }
        >
          <div className="md-collapsible-body">{children}</div>
        </div>
      </div>
    </div>
  );
}
