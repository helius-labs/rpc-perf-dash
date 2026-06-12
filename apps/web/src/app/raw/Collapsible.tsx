"use client";

/**
 * Collapsible box with the same grid-rows slide + fade reveal used across the
 * app (Overview leaderboard, methodology sections). Replaces native <details>
 * so open/close is animated.
 */

import { useState, type ReactNode } from "react";

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  className = "",
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={"overflow-hidden rounded-lg border border-line " + className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer select-none items-center gap-2 px-3.5 py-2.5 text-left font-geistmono text-[12px] text-fg2 hover:text-fg"
      >
        <span
          aria-hidden="true"
          className={"inline-block w-[9px] text-[9px] transition-transform duration-150 " + (open ? "rotate-90" : "")}
        >
          ▶
        </span>
        {title}
      </button>
      <div
        className={
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div
          className={
            "overflow-hidden transition-opacity duration-300 ease-out " + (open ? "opacity-100" : "opacity-0")
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
