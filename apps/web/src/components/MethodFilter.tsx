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
  /**
   * Where clicking the method *name* navigates. In multi mode this selects ONLY
   * this method (replacing the selection); in single mode it's the plain select.
   */
  href: string;
  /**
   * Multi mode only: where clicking the *checkbox* navigates — toggles this
   * method in/out of the current selection without disturbing the others.
   */
  toggleHref?: string;
}

interface Props {
  options: readonly MethodOption[];
  selected: string;
  /**
   * Trigger styling. "pill" (default) is the filled chip used on /performance.
   * "inline" renders the trigger as monospace text that sits inside a running
   * caption line (e.g. the Overview scope note), so the method name reads as
   * part of the sentence rather than a button.
   */
  variant?: "pill" | "inline";
  /**
   * Multi-select mode: each row has a checkbox (left) that TOGGLES that method
   * in/out of the URL list via `toggleHref` — the dropdown stays open and the
   * trigger shows the count — and the method name, which selects ONLY that
   * method via `href` and closes the dropdown. This lets you either quickly
   * switch to one method or build up a multi-method selection. The chart blends
   * the selected methods' scores. When off, picking a method replaces it.
   */
  multi?: boolean;
  selectedSet?: ReadonlySet<string>;
}

export function MethodFilter({ options, selected, variant = "pill", multi = false, selectedSet }: Props) {
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

  const triggerClass =
    variant === "inline"
      ? "cursor-pointer select-none inline-flex items-center gap-1 align-baseline " +
        "font-geistmono normal-case tracking-normal text-[11px] text-muted " +
        "underline decoration-dotted decoration-muted underline-offset-[3px] " +
        "transition-colors hover:text-fg"
      : "cursor-pointer select-none inline-flex items-center gap-1.5 " +
        "px-[11px] py-[5px] rounded-full text-[12px] font-geistmono " +
        "tracking-[0.01em] border bg-fg text-bg border-fg";

  const triggerLabel =
    multi && selectedSet
      ? selectedSet.size === 1
        ? [...selectedSet][0]
        : `${selectedSet.size} methods`
      : selected;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
      >
        <span>{triggerLabel}</span>
        <span aria-hidden className={variant === "inline" ? "text-[8px] opacity-70" : "text-[10px] opacity-70"}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable={multi || undefined}
          className={
            "absolute left-0 top-[calc(100%+6px)] z-20 min-w-[220px] " +
            "p-1.5 rounded-md border border-line bg-bg shadow-lg " +
            "max-h-[400px] overflow-y-auto"
          }
        >
          {options.map((o) => {
            const active = multi && selectedSet ? selectedSet.has(o.method) : o.method === selected;
            if (multi) {
              // Two click targets in one row: the checkbox toggles this method
              // in/out (dropdown stays open); the name selects only this method
              // (dropdown closes). Both are <Link>s so each is its own nav.
              return (
                <div
                  key={o.method}
                  role="option"
                  aria-selected={active}
                  className="flex items-center rounded text-[12px] font-geistmono tracking-[0.01em] hover:bg-line/40"
                >
                  <Link
                    href={(o.toggleHref ?? o.href) as Route}
                    scroll={false}
                    aria-label={(active ? "Remove " : "Add ") + o.method}
                    className="flex items-center pl-2.5 pr-1.5 py-[6px] shrink-0"
                  >
                    <span
                      aria-hidden
                      className={
                        "w-[14px] h-[14px] rounded-[3px] border flex items-center justify-center " +
                        "text-[9px] leading-none transition-colors " +
                        (active ? "bg-fg text-bg border-fg" : "border-line text-transparent hover:border-fg2")
                      }
                    >
                      ✓
                    </span>
                  </Link>
                  <Link
                    href={o.href as Route}
                    scroll={false}
                    onClick={() => setOpen(false)}
                    className={
                      "flex-1 min-w-0 pr-3 py-[6px] transition-colors " +
                      (active ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                    }
                  >
                    <span className="truncate">{o.method}</span>
                  </Link>
                </div>
              );
            }
            return (
              <Link
                key={o.method}
                href={o.href as Route}
                scroll={false}
                onClick={() => setOpen(false)}
                role="option"
                aria-selected={active}
                className={
                  "flex items-center gap-1.5 px-3 py-[6px] rounded text-[12px] font-geistmono " +
                  "tracking-[0.01em] transition-colors " +
                  (active ? "bg-fg text-bg" : "text-fg2 hover:text-fg hover:bg-line/40")
                }
              >
                <span className="truncate">{o.method}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
