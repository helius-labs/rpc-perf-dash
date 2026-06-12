"use client";

/**
 * Make a table row OR a card-shaped <div> navigate on click. Used by
 * /challenges and the home-page recent-challenges table+mobile cards so
 * the entire row/card is a click target for "open this challenge's /raw
 * page" — no separate "audit →" button.
 *
 * Why an onClick handler instead of wrapping in <a>:
 *   - <a> cannot legally wrap <tr> (invalid HTML, would break tables).
 *   - <a> wrapping the card-shaped <div> would nest with the <a> inside
 *     ChallengeTarget (explorer link), which is invalid HTML and triggers
 *     a hydration warning in React 19 / Next.js.
 *
 * Nested clickable elements inside the row/card (ChallengeTarget's
 * explorer link, copy button) stopPropagation so their clicks don't also
 * trigger nav.
 *
 * Cmd/Ctrl-click and middle-click open in a new tab — browsers don't
 * support these natively for non-anchor elements, so we handle them
 * explicitly to match the conventional <a> UX.
 */

import { useRouter } from "next/navigation";
import type { Route } from "next";
import type { ReactNode } from "react";

interface BaseProps {
  href: string;
  children: ReactNode;
  style?: React.CSSProperties | undefined;
  /**
   * Caller-supplied class merged onto the built-in hover styles. Used by
   * the streaming recent-challenges table to flash newly-arrived rows.
   * Explicit `| undefined` for exactOptionalPropertyTypes.
   */
  className?: string | undefined;
}

function useNavHandlers(href: string) {
  const router = useRouter();
  return {
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.button === 1) {
        window.open(href, "_blank", "noopener");
        return;
      }
      router.push(href as Route);
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        window.open(href, "_blank", "noopener");
      }
    },
  };
}

export function ClickableRow({ href, children, style, className }: BaseProps) {
  const handlers = useNavHandlers(href);
  const cls =
    "hover:bg-[#161616] transition-colors duration-100" +
    (className ? ` ${className}` : "");
  return (
    <tr
      {...handlers}
      // Subtle bg lift on hover so users notice the row is clickable.
      // Tailwind hover utility on a <tr> applies to the row's cells via
      // table background inheritance.
      className={cls}
      style={{
        cursor: "pointer",
        borderTop: "1px solid #1a1a1a",
        ...style,
      }}
    >
      {children}
    </tr>
  );
}

/**
 * Card-shaped variant for the mobile recent-challenges list. Same click
 * semantics as ClickableRow but rendered as a <div> so it can legally
 * contain nested <a> elements (ChallengeTarget's explorer link).
 *
 * Adds basic keyboard accessibility — role=link, tabIndex=0, Enter
 * navigates — since unlike <a>, a <div> isn't inherently focusable.
 */
export function ClickableCard({ href, children, style, className }: BaseProps) {
  const handlers = useNavHandlers(href);
  const router = useRouter();
  const cls =
    "hover:bg-[#161616] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#2a2a2a] transition-colors duration-100" +
    (className ? ` ${className}` : "");
  return (
    <div
      {...handlers}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(href as Route);
      }}
      // Same hover lift as ClickableRow; keyboard focus shows a subtle
      // outline so tabbing through cards is visible too.
      className={cls}
      style={{ cursor: "pointer", ...style }}
    >
      {children}
    </div>
  );
}
