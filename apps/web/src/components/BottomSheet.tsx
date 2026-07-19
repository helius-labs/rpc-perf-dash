"use client";

/**
 * Slide-up bottom sheet for delivering tooltip-style content on touch devices.
 * Portaled to document.body so it escapes any overflow-clipping ancestor.
 *
 * Controlled component: callers own the `open` state. Closes via backdrop tap
 * or the explicit "Done" button. Body scroll is locked while open so the sheet
 * content scrolls without pulling the page underneath.
 */

import {
  useEffect,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export function BottomSheet({
  open,
  onOpenChange,
  title = "Details",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
}) {
  // Lock body scroll while the sheet is open. Restores prior overflow on close.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on Escape so keyboard users (including phones with Bluetooth
  // keyboards) can dismiss.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1100]"
      aria-modal="true"
      role="dialog"
      aria-label={title}
    >
      {/* Backdrop */}
      <div
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
      />
      {/* Sheet — pb-[env(...)] honors the iOS home-indicator safe area. */}
      <div className="absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col rounded-t-[14px] border-t border-line2 bg-surface text-fg shadow-[0_-16px_48px_rgba(0,0,0,0.6)] pb-[env(safe-area-inset-bottom)]">
        {/* Drag handle (decorative) */}
        <div className="mx-auto mt-2 mb-1 h-1 w-10 shrink-0 rounded-sm bg-line2" />
        <div className="flex shrink-0 items-center justify-between border-b border-line pt-1.5 px-4 pb-2.5">
          <div className="text-[14px] font-semibold">{title}</div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-[#2a4a66] bg-transparent px-3 py-1 text-[13px] text-[#7cc6ff] font-[inherit] cursor-pointer"
          >
            Done
          </button>
        </div>
        {/* font-normal so children inherit a clean weight regardless of the
            trigger context (e.g. tap originating from a <th>). */}
        <div className="overflow-y-auto pt-3 px-4 pb-5 text-[12px] font-normal">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
