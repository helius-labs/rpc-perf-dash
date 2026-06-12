"use client";

/**
 * Reusable hover tooltip with a mobile fallback.
 *
 * Desktop (hover-capable input): the popup appears below the trigger on
 * hover, driven by a CSS-only `group-hover` rule that is itself gated by
 * `@media (hover: hover)` so it never renders on touch devices.
 *
 * Touch (no hover): tap the trigger to open a BottomSheet with the same
 * children. Avoids the "stuck tooltip" UX that pure hover-driven CSS has on
 * iOS / Android.
 *
 * INVARIANT: `trigger` and `children` must be serializable JSX — no functions,
 * no closures, no class instances. Tooltip is now a client component and gets
 * embedded inside server components (page.tsx, ProviderHealth.tsx), so the
 * RSC ↔ client boundary serializes everything that crosses it.
 */
import { Fragment, useState, type ReactNode } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { BottomSheet } from "./BottomSheet";

export function Tooltip({
  trigger,
  children,
  align = "left",
  title = "Details",
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  title?: string;
}) {
  const touch = useMediaQuery("(hover: none)");
  const [open, setOpen] = useState(false);

  return (
    <>
      <span
        className="relative group inline-block"
        onClick={
          touch
            ? (e) => {
                // Prevent ancestor links (e.g. region Pill <a>) from following
                // their href when the user is tapping for info.
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
              }
            : undefined
        }
        // Make trigger feel tappable on touch.
        style={touch ? { cursor: "pointer" } : undefined}
      >
        {/* Keyed so the caller's trigger element isn't flagged as an unkeyed
            list child (it sits in a 2-element children array with the popup). */}
        <Fragment key="trigger">{trigger}</Fragment>
        {/* Desktop hover popup. CSS-gated to (hover: hover) — never renders on
            touch devices regardless of focus state. */}
        <span
          key="popup"
          role="tooltip"
          className={[
            "tooltip-hover-popup",
            "absolute top-full mt-1 z-50",
            align === "right" ? "right-0" : "left-0",
            "min-w-[260px] max-w-[420px]",
            "rounded-md border border-neutral-700 bg-neutral-950/95 backdrop-blur",
            // font-normal resets bold inherited from a <th> trigger context.
            "px-3 py-2 text-xs text-neutral-200 font-normal",
            "shadow-xl shadow-black/60",
            "pointer-events-none",
          ].join(" ")}
        >
          {children}
        </span>
      </span>
      {touch && (
        <BottomSheet open={open} onOpenChange={setOpen} title={title}>
          {children}
        </BottomSheet>
      )}
    </>
  );
}
