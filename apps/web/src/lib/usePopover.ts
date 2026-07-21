"use client";

/**
 * Popover positioning for dropdown menus that must escape clipping ancestors —
 * an `overflow-x-auto` filter strip, and (critically) the embed iframe's own
 * edge. An absolutely-positioned menu is clipped to the nearest scroll box and
 * can never paint outside the iframe rectangle, so in narrow embeds the menu
 * gets cut off. This renders the menu in a portal to <body> with `position:
 * fixed`, anchored under the trigger and CLAMPED into the viewport (shifts left
 * when it would overflow the right/left edge, flips above when there's no room
 * below). Same behavior on the full site and inside the frame.
 *
 * Usage:
 *   const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
 *   <button ref={triggerRef} onClick={() => setOpen(o => !o)} />
 *   {open && createPortal(
 *     <div ref={panelRef} style={panelStyle} className="…menu styling…">…</div>,
 *     document.body,
 *   )}
 * Omit `absolute/right-0/top-…/z-…` from the menu className — position comes from
 * panelStyle. Keep sizing (min-w, max-h, overflow-y-auto) and the visual styling.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";

const MARGIN = 8; // keep this far from the viewport edges
const GAP = 6; // gap between trigger and menu
const MAX_H = 400; // natural cap; shrunk further to fit a short frame
const MIN_H = 120; // don't shrink below this — scroll internally instead

export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  // Starts off-screen + hidden so there's never a flash at a stale position: the
  // menu renders hidden, we measure it, then place + reveal in the same effect.
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({
    position: "fixed",
    left: -9999,
    top: -9999,
    zIndex: 50,
    visibility: "hidden",
  });
  const triggerRef = useRef<T>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setPanelStyle((s) => ({ ...s, visibility: "hidden" }));
      return;
    }
    const place = () => {
      const t = triggerRef.current;
      const p = panelRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const pw = p?.offsetWidth ?? 0;
      // Natural content height (ignores our own maxHeight cap) — how tall the menu
      // WANTS to be, so we can decide whether it fits without shrinking.
      const desired = Math.min(p?.scrollHeight ?? 0, MAX_H);

      // Horizontal: clamp within the viewport (shift left off the right edge).
      let left = r.left;
      if (pw) {
        if (left + pw + MARGIN > vw) left = vw - pw - MARGIN;
        if (left < MARGIN) left = MARGIN;
      }

      // Vertical: open on whichever side has more room; cap the height to that
      // room so the menu never spills past the frame edge (it scrolls internally
      // instead). This is what keeps a tall menu inside a short embed iframe.
      const spaceBelow = vh - r.bottom - GAP - MARGIN;
      const spaceAbove = r.top - GAP - MARGIN;
      const openBelow = spaceBelow >= desired || spaceBelow >= spaceAbove;
      const room = Math.max(openBelow ? spaceBelow : spaceAbove, 0);
      const maxHeight = Math.max(MIN_H, Math.min(MAX_H, room));
      const height = Math.min(desired, maxHeight);
      let top = openBelow ? r.bottom + GAP : r.top - GAP - height;
      if (top < MARGIN) top = MARGIN;
      if (top + height + MARGIN > vh) top = Math.max(MARGIN, vh - height - MARGIN);

      setPanelStyle({
        position: "fixed",
        left,
        top,
        maxHeight,
        zIndex: 50,
        // Only reveal once the menu has real dimensions (so the clamp is correct).
        visibility: pw ? "visible" : "hidden",
      });
    };
    place();
    // Re-place after the menu has committed its real size, and track scroll/resize.
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const n = e.target as Node;
      // The menu is portaled outside the trigger's wrapper — check both.
      if (!triggerRef.current?.contains(n) && !panelRef.current?.contains(n)) {
        setOpen(false);
      }
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

  return { open, setOpen, triggerRef, panelRef, panelStyle };
}
