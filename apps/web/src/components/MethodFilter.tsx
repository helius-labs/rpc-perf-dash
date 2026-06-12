"use client";

/**
 * Method filter for the dashboard chart. The benchmarked method set grew past
 * a comfortable flat pill row, so this collapses it into a dropdown showing the
 * selected method and expanding to the full list.
 *
 * Client component: it manages open state so the dropdown closes on an
 * outside click, on Escape, and on selection (a native <details> wouldn't
 * close on an outside click). Navigation is still <Link> with scroll={false}
 * so picking a method updates the ?method= param in place without jumping the
 * page to the top. Hrefs are precomputed server-side and passed as plain data
 * (no function prop crosses the server→client boundary).
 */

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useRef, useState } from "react";

export interface MethodOption {
  method: string;
  href: string;
}

interface Props {
  options: readonly MethodOption[];
  selected: string;
}

export function MethodFilter({ options, selected }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          "cursor-pointer select-none inline-flex items-center gap-1.5 " +
          "px-[11px] py-[5px] rounded-full text-[12px] font-geistmono " +
          "tracking-[0.01em] border bg-fg text-bg border-fg"
        }
      >
        <span>{selected}</span>
        <span aria-hidden className="text-[10px] opacity-70">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          className={
            "absolute left-0 top-[calc(100%+6px)] z-20 min-w-[220px] " +
            "p-1.5 rounded-md border border-line bg-bg shadow-lg " +
            "max-h-[400px] overflow-y-auto"
          }
        >
          {options.map((o) => {
            const active = o.method === selected;
            return (
              <Link
                key={o.method}
                href={o.href as Route}
                scroll={false}
                onClick={() => setOpen(false)}
                role="option"
                aria-selected={active}
                className={
                  "block px-3 py-[6px] rounded text-[12px] font-geistmono " +
                  "tracking-[0.01em] transition-colors " +
                  (active ? "bg-fg text-bg" : "text-fg2 hover:text-fg hover:bg-line/40")
                }
              >
                {o.method}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
