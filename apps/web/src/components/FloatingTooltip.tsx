"use client";

/**
 * Tooltip that renders its popup via a React portal to document.body so it
 * escapes any `overflow: auto/hidden` ancestor (e.g. the leaderboard's scroll
 * container). Positioned above the trigger by default on hover-capable
 * devices. On touch devices the popup is replaced by a BottomSheet so the
 * full content is visible above the on-screen keyboard / page chrome.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { BottomSheet } from "./BottomSheet";

interface Pos {
  top: number;
  left: number;
}

export function FloatingTooltip({
  trigger,
  children,
  title = "Details",
}: {
  trigger: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  const touch = useMediaQuery("(hover: none)");
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  const reposition = useCallback(() => {
    const tEl = triggerRef.current;
    const pEl = popupRef.current;
    if (!tEl || !pEl) return;
    const t = tEl.getBoundingClientRect();
    const p = pEl.getBoundingClientRect();
    const gap = 8;
    // Default: above the trigger, horizontally centered on it.
    let top = t.top - p.height - gap;
    let left = t.left + t.width / 2 - p.width / 2;
    // Flip below if there isn't room above.
    if (top < 8) top = t.bottom + gap;
    // Keep within viewport horizontally with an 8px margin.
    const maxLeft = window.innerWidth - p.width - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;
    setPos({ top, left });
  }, []);

  // Recompute position while open: after mount, on scroll, on resize.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => reposition();
    // Capture-phase so we catch ancestor scroll containers too.
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, reposition]);

  return (
    <>
      <span
        ref={triggerRef}
        // Hover/focus open the floating popup on desktop. On touch the open
        // event is fired by the tap handler instead so the floating popup
        // never renders — only the BottomSheet does.
        onMouseEnter={touch ? undefined : () => setOpen(true)}
        onMouseLeave={touch ? undefined : () => setOpen(false)}
        onFocus={touch ? undefined : () => setOpen(true)}
        onBlur={touch ? undefined : () => setOpen(false)}
        onClick={
          touch
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
              }
            : undefined
        }
        style={{ display: "inline-block", cursor: touch ? "pointer" : "help" }}
      >
        {trigger}
      </span>
      {touch ? (
        <BottomSheet open={open} onOpenChange={setOpen} title={title}>
          {children}
        </BottomSheet>
      ) : (
        open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popupRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              zIndex: 1000,
              pointerEvents: "none",
              // Hide until first measurement to avoid a one-frame flash at (0,0).
              visibility: pos ? "visible" : "hidden",
            }}
            className={[
              "min-w-[280px] max-w-[480px]",
              "rounded-md border border-neutral-700 bg-neutral-950/95 backdrop-blur",
              "px-3 py-2 text-xs text-neutral-200 font-normal",
              "shadow-xl shadow-black/60",
            ].join(" ")}
          >
            {children}
          </div>,
          document.body,
        )
      )}
    </>
  );
}
