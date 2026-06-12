"use client";

/**
 * A chart-filter pill. Uses Next's useLinkStatus so the clicked pill flips to
 * its active/pending style the instant it's clicked — before the (slow,
 * fully-dynamic) server re-render returns — instead of waiting for the new
 * server payload to recompute the active state.
 */

import Link from "next/link";
import { useLinkStatus } from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

function PillBody({ active, children }: { active: boolean; children: ReactNode }) {
  const { pending } = useLinkStatus();
  const on = active || pending;
  return (
    <span
      aria-current={active ? "true" : undefined}
      className={
        "inline-block border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] transition-colors " +
        (on ? "bg-fg text-bg" : "bg-transparent text-fg2 hover:text-fg") +
        (pending ? " animate-pulse" : "")
      }
    >
      {children}
    </span>
  );
}

export function FilterPill({
  active,
  href,
  children,
  disabled = false,
  title,
}: {
  active: boolean;
  href: string;
  children: ReactNode;
  /** Dim + make non-clickable — e.g. an infra with no workers in the selected
   *  region (or vice-versa). The active pill is never disabled so it can still
   *  be deselected. */
  disabled?: boolean;
  title?: string | undefined;
}) {
  if (disabled) {
    return (
      <span
        title={title}
        aria-disabled="true"
        className="inline-block border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] text-fg2 opacity-30 cursor-not-allowed select-none"
      >
        {children}
      </span>
    );
  }
  // scroll={false}: soft-nav updates searchParams without jumping to the top.
  return (
    <Link href={href as Route} scroll={false} className="no-underline hover:no-underline">
      <PillBody active={active}>{children}</PillBody>
    </Link>
  );
}
