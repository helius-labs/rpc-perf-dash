"use client";

/**
 * MethodSelectPill — the Overview's "which methods are in the blend" control.
 * A preset-pill-styled trigger ("N methods ▾") that opens a multi-select
 * checklist, visually matching the /performance chart's MethodFilter dropdown.
 *
 * Unlike MethodFilter (URL-driven via <Link>), this is pure client state: the
 * Overview re-blends the already-fetched cube on toggle, so selection needs no
 * navigation / server round-trip. Each row has two targets — the checkbox
 * toggles that method in/out (dropdown stays open), the name selects ONLY it
 * (dropdown closes) — mirroring MethodFilter's multi mode.
 */

import { useEffect, useRef, useState } from "react";
import type { Method } from "@rpcbench/shared/types";

export function MethodSelectPill({
  options,
  selected,
  onToggle,
  onOnly,
  triggerClass,
  className,
}: {
  options: readonly Method[];
  selected: ReadonlySet<string>;
  /** Toggle a method in/out of the selection (never empties — last one is a no-op). */
  onToggle: (method: Method) => void;
  /** Select only this method (replace the whole selection). */
  onOnly: (method: Method) => void;
  /** Pill styling for the trigger (shared with the preset pills). */
  triggerClass: string;
  /** Wrapper classes (e.g. a fixed width) so the pill sizes like its siblings. */
  className?: string;
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

  const label = selected.size === 1 ? [...selected][0] : `${selected.size} methods`;

  return (
    <div ref={ref} className={"relative " + (className ?? "inline-block shrink-0")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute left-0 top-[calc(100%+6px)] z-20 min-w-[220px] p-1.5 rounded-md border border-line bg-bg shadow-lg max-h-[400px] overflow-y-auto"
        >
          {options.map((m) => {
            const active = selected.has(m);
            return (
              <div
                key={m}
                role="option"
                aria-selected={active}
                className="flex items-center rounded text-[12px] font-geistmono tracking-[0.01em] hover:bg-line/40"
              >
                <button
                  type="button"
                  onClick={() => onToggle(m)}
                  aria-label={(active ? "Remove " : "Add ") + m}
                  className="flex items-center pl-2.5 pr-1.5 py-[6px] shrink-0 cursor-pointer"
                >
                  <span
                    aria-hidden
                    className={
                      "w-[14px] h-[14px] rounded-[3px] border flex items-center justify-center text-[9px] leading-none transition-colors " +
                      (active ? "bg-fg text-bg border-fg" : "border-line text-transparent hover:border-fg2")
                    }
                  >
                    ✓
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onOnly(m);
                    setOpen(false);
                  }}
                  className={
                    "flex-1 min-w-0 text-left pr-3 py-[6px] cursor-pointer transition-colors " +
                    (active ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                  }
                >
                  <span className="truncate">{m}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
