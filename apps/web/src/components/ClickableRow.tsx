"use client";

/**
 * Make a table row navigate on click — the whole row opens the challenge's
 * /raw page. We use an onClick handler rather than an <a> because <a> cannot
 * legally wrap <tr>. Cmd/Ctrl-click and middle-click are handled explicitly to
 * open a new tab, since browsers don't do that for non-anchor elements. Nested
 * links/buttons stopPropagation so their clicks don't also trigger nav.
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
