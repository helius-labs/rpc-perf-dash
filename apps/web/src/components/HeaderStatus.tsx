"use client";

/**
 * Header status pill — a colored dot + "Status" link in the site header, with
 * a hover tooltip showing a compact fleet summary (full detail lives on
 * /status). Polls via useFleetStatus so static pages stay static; renders a
 * neutral dot until the first response lands. Hidden ≤640px — the mobile
 * drawer's Status row carries the dot there.
 */

import Link from "next/link";
import { FLEET_DOT, type FleetStatus } from "@/lib/fleetStatus";
import { useFleetStatus } from "./useFleetStatus";
import { FloatingTooltip } from "./FloatingTooltip";

const HEADLINE: Record<FleetStatus, string> = {
  ok: "All systems operational",
  degraded: "Partially degraded",
  down: "Pipeline down",
  absent: "Awaiting fleet data",
};

export default function HeaderStatus() {
  const summary = useFleetStatus();
  const dot = summary ? FLEET_DOT[summary.status] : FLEET_DOT.absent;

  const pill = (
    <Link
      href="/status"
      className="inline-flex items-center gap-2 rounded-full border border-line2 px-3 py-[5px] text-[12px] font-medium text-fg2 transition-colors hover:text-fg hover:border-fg2 hover:no-underline"
    >
      <span className="relative inline-flex h-2 w-2" aria-hidden="true">
        {summary && (
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

  // The hide class lives on this wrapper, not the <Link>: FloatingTooltip wraps
  // its trigger in its own inline-block span, so hiding the inner link alone
  // would leave a zero-width empty wrapper on mobile.
  return (
    <span className="max-[640px]:hidden">
      <FloatingTooltip title="Fleet status" trigger={pill}>
        {summary ? (
          <>
            <div className="flex items-center gap-1.5 font-medium mb-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: dot }}
                aria-hidden="true"
              />
              {HEADLINE[summary.status]}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-neutral-300">
              <dt className="text-neutral-400">Vantages</dt>
              <dd className="tabular-nums">
                {summary.infra.live}/{summary.infra.total} live
              </dd>
              <dt className="text-neutral-400">Benchmarked</dt>
              <dd className="tabular-nums">
                {summary.benchmarked.healthy}/{summary.benchmarked.total} healthy
              </dd>
              <dt className="text-neutral-400">Auditor</dt>
              <dd>{summary.auditor.healthy ? "responding" : "unreachable"}</dd>
            </dl>
          </>
        ) : (
          <div className="text-neutral-400">Checking fleet status…</div>
        )}
      </FloatingTooltip>
    </span>
  );
}
