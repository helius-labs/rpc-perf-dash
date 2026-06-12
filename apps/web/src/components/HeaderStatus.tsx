"use client";

/**
 * Header status pill — a colored dot + "Status" link in the site header.
 * Polls via useFleetStatus so static pages stay static; renders a neutral dot
 * until the first response lands. Hidden ≤640px — the mobile drawer's Status
 * row carries the dot there.
 */

import Link from "next/link";
import { FLEET_DOT } from "@/lib/fleetStatus";
import { useFleetStatus } from "./useFleetStatus";

export default function HeaderStatus() {
  const status = useFleetStatus();
  const dot = status ? FLEET_DOT[status] : FLEET_DOT.absent;
  return (
    <Link
      href="/status"
      className="inline-flex items-center gap-2 rounded-full border border-line2 px-3 py-[5px] text-[12px] font-medium text-fg2 transition-colors hover:text-fg hover:border-fg2 hover:no-underline max-[640px]:hidden"
    >
      <span className="relative inline-flex h-2 w-2" aria-hidden="true">
        {status && (
          <span
            className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
            style={{ background: dot }}
          />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: dot }} />
      </span>
      Status
    </Link>
  );
}
