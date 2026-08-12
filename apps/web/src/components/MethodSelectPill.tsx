"use client";

/**
 * MethodSelectPill — the Overview's "which methods are in the blend" control.
 * A preset-pill-styled trigger ("N methods ▾") that opens a multi-select
 * checklist, visually matching the /performance chart's MethodFilter dropdown.
 *
 * Above the checklist sit the shortcut rows: "All methods" plus one row per
 * METHOD_GROUPS entry (Archival / Account-based), each replacing the selection
 * with that workload family.
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

import { useMemo } from "react";
import { createPortal } from "react-dom";
import type { Method } from "@rpcbench/shared/types";
import { METHOD_GROUPS } from "@/lib/methods";
import { usePopover } from "@/lib/usePopover";

export function MethodSelectPill({
  options,
  selected,
  onToggle,
  onOnly,
  onAll,
  onSelectMany,
  onPrefetch,
  onPrefetchMany,
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
   * Optional: replace the selection with a whole method group. When provided,
   * a row per METHOD_GROUPS entry ("Archival", "Account-based") is shown under
   * "All methods" — a one-click way to scope the view to a workload family.
   * Like "All methods", the dropdown stays open so the pick can be refined.
   */
  onSelectMany?: (methods: Method[]) => void;
  /**
   * Optional: warm the data a click on this row would need, on hover. Used by
   * /performance (where a toggle triggers a fetch) to make the pick feel
   * instant; Overview omits it (its re-blend is already zero-network).
   */
  onPrefetch?: (method: Method) => void;
  /** Optional: the group-row equivalent of `onPrefetch`. */
  onPrefetchMany?: (methods: Method[]) => void;
  /** Pill styling for the trigger (shared with the preset pills). */
  triggerClass: string;
  /** Wrapper classes (e.g. a fixed width) so the pill sizes like its siblings. */
  className?: string;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
  const allSelected = selected.size === options.length;

  // Group rows, narrowed to the methods this picker offers. Every caller today
  // passes the full ALL_METHODS set, so the narrowing is a no-op — it's here so
  // a picker with a smaller `options` list can't select a method it doesn't
  // show, and drops any group left with nothing to select.
  const groups = useMemo(() => {
    if (!onSelectMany) return [];
    const available = new Set<string>(options);
    return METHOD_GROUPS.map((g) => ({
      ...g,
      methods: g.methods.filter((m) => available.has(m)),
    })).filter((g) => g.methods.length > 0);
  }, [onSelectMany, options]);

  const isGroupSelected = (methods: readonly Method[]) =>
    selected.size === methods.length && methods.every((m) => selected.has(m));
  const activeGroup = groups.find((g) => isGroupSelected(g.methods));

  const label = allSelected
    ? "All methods"
    : activeGroup
      ? activeGroup.label
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
                role="option"
                aria-selected={allSelected}
                onClick={onAll}
                className={
                  "flex w-full items-center text-left rounded px-2.5 py-[6px] mb-0.5 text-[12px] font-geistmono tracking-[0.01em] cursor-pointer transition-colors hover:bg-line/40 " +
                  (allSelected ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                }
              >
                All methods
              </button>
            )}
            {groups.length > 0 && onSelectMany && (
              <div className="mb-1 pb-1 border-b border-line/60">
                {groups.map((g) => {
                  const active = isGroupSelected(g.methods);
                  return (
                    <button
                      key={g.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      title={g.title}
                      onClick={() => onSelectMany([...g.methods])}
                      onMouseEnter={
                        onPrefetchMany ? () => onPrefetchMany([...g.methods]) : undefined
                      }
                      className={
                        "flex w-full items-center text-left rounded px-2.5 py-[6px] text-[12px] font-geistmono tracking-[0.01em] cursor-pointer transition-colors hover:bg-line/40 " +
                        (active ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                      }
                    >
                      <span className="truncate">{g.label}</span>
                    </button>
                  );
                })}
              </div>
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
