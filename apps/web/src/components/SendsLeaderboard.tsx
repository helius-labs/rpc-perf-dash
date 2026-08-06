"use client";

/**
 * Sends leaderboard — the same "Index, dark" ranked list as the RPC board, with
 * click-to-expand rows (mirroring IndexLeaderboard). The collapsed row shows
 * landing rate (with the same failure-breakdown tooltip the RPC board uses),
 * slot latency, and cost; the expanded row shows the per-metric detail + the
 * full outcome breakdown. Ranks by the send score.
 */

import { useCallback, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { brandColorFor } from "@/lib/providerColors";
import {
  FailureBreakdownList,
  scoreColor,
  type FailureBreakdownEntry,
} from "@/components/leaderboardShared";
import { FloatingTooltip } from "@/components/FloatingTooltip";
import {
  PROVIDERS,
  benchmarkedProviderByRouteParam,
  slugForProviderId,
  websiteForProviderId,
} from "@rpcbench/shared/providers";
import type { SendBoardRow } from "@/lib/sends";

const fmt = (v: number | null): string => (v == null ? "—" : Math.round(v).toLocaleString());

/** Display name — the registry name (proper casing), else title-cased id. */
function labelFor(id: string): string {
  const p = PROVIDERS.find((row) => row.id === id);
  if (p) return p.name;
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** One labeled cell in the expanded detail strip (RPC idx-ds style). */
function DS({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="idx-ds">
      <span className="idx-ds-l">{label}</span>
      <span className="idx-ds-v">{children}</span>
    </span>
  );
}

function Row({ r, index, isOpen, toggle }: { r: SendBoardRow; index: number; isOpen: boolean; toggle: (id: string) => void }) {
  const isLeader = index === 0;
  const leaderColor = isLeader ? brandColorFor(r.send_target) : null;
  const tierColor = scoreColor(r.total);
  const lineStyle: React.CSSProperties = {
    backgroundImage: `linear-gradient(90deg, transparent 0%, ${tierColor} ${r.total}%, transparent ${r.total}%)`,
  };
  const o = r.outcomes;
  // Failures behind a <100% landing rate: not_landed + submit_error (reverted
  // counts as landed). Same shape + tooltip the RPC board uses.
  const failed = o.not_landed + o.submit_error;
  const breakdown: FailureBreakdownEntry[] = [
    { category: "not_landed", n: o.not_landed },
    { category: "submit_error", n: o.submit_error },
  ].filter((e) => e.n > 0);
  const website = websiteForProviderId(r.send_target);

  const landStat = (
    <span className="idx-rowstat" style={failed > 0 ? { cursor: "help" } : undefined}>
      <b>{(r.landing_rate * 100).toFixed(1)}</b>
      <i>% land</i>
    </span>
  );

  return (
    <li className="idx-li">
      <div
        className={"idx-row" + (isLeader ? " idx-row-leader" : "") + (isOpen ? " idx-row-open" : "")}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => toggle(r.send_target)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(r.send_target);
          }
        }}
      >
        <span className="idx-rank" style={leaderColor ? { color: leaderColor } : undefined}>
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="idx-name" style={leaderColor ? { color: leaderColor } : undefined}>
          {labelFor(r.send_target)}
        </span>
        <span className="idx-rowstats">
          {failed > 0 ? (
            <span onClick={(e) => e.stopPropagation()}>
              <FloatingTooltip title="Failure breakdown" trigger={landStat}>
                <div className="text-left font-normal normal-case tracking-normal leading-normal">
                  <FailureBreakdownList breakdown={breakdown} totalFailed={failed} />
                </div>
              </FloatingTooltip>
            </span>
          ) : (
            landStat
          )}
          <span className="idx-rowstat">
            <b>{fmt(r.slot_latency_p50)}</b>
            <i> slot p50</i>
          </span>
          <span className="idx-rowstat">
            <b>{fmt(r.cost_lamports)}</b>
            <i> lam/tx</i>
          </span>
        </span>
        <span className="idx-score" style={{ color: tierColor }}>
          {r.total.toFixed(1)}
          <i className="idx-score-unit">/100</i>
        </span>
        <span className="idx-score-line" style={lineStyle} aria-hidden="true" />
        <span className="idx-actions">
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noopener nofollow"
              className="idx-website"
              aria-label={`Visit ${labelFor(r.send_target)}'s website`}
              title={`Visit ${labelFor(r.send_target)}'s website`}
              onClick={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" />
                <path
                  d="M3 12h18M12 3c2.5 2.4 3.9 5.7 4 9-.1 3.3-1.5 6.6-4 9-2.5-2.4-3.9-5.7-4-9 .1-3.3 1.5-6.6 4-9z"
                  stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
            </a>
          )}
          {benchmarkedProviderByRouteParam(r.send_target) && (
            <Link
              href={`/provider/${slugForProviderId(r.send_target)}` as Route}
              className="idx-arrow"
              aria-label={`Open ${labelFor(r.send_target)} details page`}
              onClick={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
                <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          )}
        </span>
      </div>

      {/* Expanded detail — per-metric strip + outcome counts. */}
      <div
        className={
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div className={"overflow-hidden transition-opacity duration-300 ease-out " + (isOpen ? "opacity-100" : "opacity-0")}>
          <div className={"idx-detail" + (isLeader ? " idx-detail-leader" : "")}>
            <div className="idx-detail-secondary">
              <DS label="slot p50 / p95">{fmt(r.slot_latency_p50)} / {fmt(r.slot_latency_p95)}</DS>
              <DS label="cost / tx">{fmt(r.cost_lamports)}<i>lam</i></DS>
              <DS label="samples">{r.sample_count_total.toLocaleString()}</DS>
            </div>
            <div className="idx-detail-secondary" style={{ marginTop: 10 }}>
              <DS label="landed">{o.landed.toLocaleString()}</DS>
              <DS label="reverted">{o.reverted.toLocaleString()}</DS>
              <DS label="not landed">{o.not_landed.toLocaleString()}</DS>
              <DS label="submit error">{o.submit_error.toLocaleString()}</DS>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

export function SendsLeaderboard({ rows }: { rows: SendBoardRow[] }) {
  // First row expanded on load, like the RPC board.
  const [open, setOpen] = useState<Set<string>>(() => {
    const first = rows[0]?.send_target;
    return new Set(first ? [first] : []);
  });
  const toggle = useCallback(
    (id: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  return (
    <ol className="idx-list">
      {rows.map((r, i) => (
        <Row key={r.send_target} r={r} index={i} isOpen={open.has(r.send_target)} toggle={toggle} />
      ))}
    </ol>
  );
}
