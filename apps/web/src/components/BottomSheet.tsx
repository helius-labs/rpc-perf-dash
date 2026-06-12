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
      style={{ position: "fixed", inset: 0, zIndex: 1100 }}
      aria-modal="true"
      role="dialog"
      aria-label={title}
    >
      {/* Backdrop */}
      <div
        onClick={() => onOpenChange(false)}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.55)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
      />
      {/* Sheet */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          borderTop: "1px solid #404040",
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          background: "rgb(10, 10, 10)",
          color: "rgb(229, 229, 229)",
          boxShadow: "0 -16px 48px rgba(0, 0, 0, 0.6)",
          // Honor the iOS home-indicator safe area.
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Drag handle (decorative) */}
        <div
          style={{
            width: 40,
            height: 4,
            background: "#3a3a3a",
            borderRadius: 2,
            margin: "8px auto 4px",
            flexShrink: 0,
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 16px 10px",
            borderBottom: "1px solid #1f1f1f",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            style={{
              fontSize: 13,
              padding: "4px 12px",
              background: "transparent",
              color: "#7cc6ff",
              border: "1px solid #2a4a66",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Done
          </button>
        </div>
        <div
          style={{
            overflowY: "auto",
            padding: "12px 16px 20px",
            fontSize: 12,
            // font-normal so children inherit a clean weight regardless of the
            // trigger context (e.g. tap originating from a <th>).
            fontWeight: 400,
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
