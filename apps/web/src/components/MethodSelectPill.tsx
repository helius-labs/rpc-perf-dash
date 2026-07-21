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
 *
 * The open panel is portaled + viewport-clamped via usePopover, so the filter
 * bar's `overflow-x-auto` strip and the embed iframe's edge never clip it.
 */

import { createPortal } from "react-dom";
import type { Method } from "@rpcbench/shared/types";
import { usePopover } from "@/lib/usePopover";

export function MethodSelectPill({
  options,
  selected,
  onToggle,
  onOnly,
  onAll,
  onPrefetch,
  triggerClass,
  className,
}: {
  options: readonly Method[];
  selected: ReadonlySet<string>;
  /** Toggle a method in/out of the selection (never empties — last one is a no-op). */
  onToggle: (method: Method) => void;
  /** Select only this method (replace the whole selection). */
  onOnly: (method: Method) => void;
  /**
   * Optional: select every method at once. When provided, an "All methods" row
   * is shown at the top of the checklist (mirroring the RPC dropdown's "Show
   * all"); the dropdown stays open so the pick can be refined.
   */
  onAll?: () => void;
  /**
   * Optional: warm the data a click on this row would need, on hover. Used by
   * /performance (where a toggle triggers a fetch) to make the pick feel
   * instant; Overview omits it (its re-blend is already zero-network).
   */
  onPrefetch?: (method: Method) => void;
  /** Pill styling for the trigger (shared with the preset pills). */
  triggerClass: string;
  /** Wrapper classes (e.g. a fixed width) so the pill sizes like its siblings. */
  className?: string;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
  const allSelected = selected.size === options.length;
  const label = allSelected
    ? "All methods"
    : selected.size === 1
      ? [...selected][0]
      : `${selected.size} methods`;

  return (
    <div className={"relative " + (className ?? "inline-block shrink-0")}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClass}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">▾</span>
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-multiselectable
            style={panelStyle}
            className="min-w-[220px] p-1.5 rounded-md border border-line bg-bg shadow-lg max-h-[400px] overflow-y-auto"
          >
            {onAll && (
              <button
                type="button"
                onClick={onAll}
                className={
                  "flex w-full items-center text-left rounded px-2.5 py-[6px] mb-0.5 text-[12px] font-geistmono tracking-[0.01em] cursor-pointer transition-colors hover:bg-line/40 " +
                  (allSelected ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                }
              >
                All methods
              </button>
            )}
            {options.map((m) => {
              const active = selected.has(m);
              return (
                <div
                  key={m}
                  role="option"
                  aria-selected={active}
                  onMouseEnter={onPrefetch ? () => onPrefetch(m) : undefined}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
