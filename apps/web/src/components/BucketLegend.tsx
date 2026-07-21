"use client";

/**
 * Click-to-open explainer for challenge bucket tags. A small help icon opens a
 * panel listing every bucket segment grouped by color category, sourced from
 * the shared glossary in `bucketGlossary.ts`.
 *
 * The legend has ~46 entries, which does not fit FloatingTooltip (its desktop
 * popup is pointerEvents:none, has no max-height, and closes on mouseleave). So
 * this uses a click-to-open portal panel with pointer events enabled, a capped
 * height, and scroll — closing on outside-click / Escape. On touch devices it
 * reuses the scrollable BottomSheet.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { BottomSheet } from "./BottomSheet";
import { LEGEND_GROUPS, TAG_COLORS } from "./bucketGlossary";

const TITLE = "What the bucket tags mean";

function LegendBody() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-neutral-400">
        Each challenge runs a specific scenario. The bucket name encodes that
        scenario as <code>tag__tag</code> dimensions. Hover any tag in a row to
        see its meaning.
      </p>
      {LEGEND_GROUPS.map((g) => (
        <div key={g.category}>
          <div className="flex items-center gap-1.5 mb-1">
            <span
              aria-hidden="true"
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: TAG_COLORS[g.category].fg,
              }}
            />
            <span className="font-medium text-neutral-200">{g.label}</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {g.entries.map((e) => (
              <li key={e.label} className="flex gap-2">
                <span
                  className="shrink-0"
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    color: TAG_COLORS[g.category].fg,
                    minWidth: 92,
                  }}
                >
                  {e.label}
                </span>
                <span className="text-neutral-400">{e.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function BucketLegend() {
  const touch = useMediaQuery("(hover: none)");
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const tEl = triggerRef.current;
    const pEl = panelRef.current;
    if (!tEl || !pEl) return;
    const t = tEl.getBoundingClientRect();
    const p = pEl.getBoundingClientRect();
    const gap = 8;
    // Default: below the trigger, left edges aligned.
    let top = t.bottom + gap;
    let left = t.left;
    // Flip above if there isn't room below and there is room above.
    const maxTop = window.innerHeight - p.height - 8;
    if (top > maxTop && t.top - gap > p.height) top = t.top - p.height - gap;
    if (top > maxTop) top = Math.max(8, maxTop);
    // Keep within viewport horizontally with an 8px margin.
    const maxLeft = window.innerWidth - p.width - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open && !touch) reposition();
  }, [open, touch, reposition]);

  useEffect(() => {
    if (!open || touch) return;
    const onScrollOrResize = () => reposition();
    // Capture-phase to catch ancestor scroll containers too.
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, touch, reposition]);

  // Outside-click + Escape close (desktop panel only; BottomSheet owns its own).
  useEffect(() => {
    if (!open || touch) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, touch]);

  const toggle = () => setOpen((o) => !o);

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-label={TITLE}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className="shrink-0 inline-flex h-4 w-4 items-center justify-center cursor-help text-muted transition-colors hover:text-fg2"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.3v3.4" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </span>
      {touch ? (
        <BottomSheet open={open} onOpenChange={setOpen} title={TITLE}>
          <LegendBody />
        </BottomSheet>
      ) : (
        open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={TITLE}
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              zIndex: 1000,
              maxHeight: "min(70vh, 560px)",
              overflowY: "auto",
              // Hide until first measurement to avoid a one-frame flash at (0,0).
              visibility: pos ? "visible" : "hidden",
            }}
            className={[
              "w-[340px] max-w-[calc(100vw-16px)]",
              "rounded-md border border-neutral-700 bg-neutral-950/95 backdrop-blur",
              "px-3 py-2.5 text-xs text-neutral-200 font-normal normal-case tracking-normal",
              "shadow-xl shadow-black/60",
            ].join(" ")}
          >
            <LegendBody />
          </div>,
          document.body,
        )
      )}
    </>
  );
}
