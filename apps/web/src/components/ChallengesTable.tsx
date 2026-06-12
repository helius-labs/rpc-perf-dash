"use client";

/**
 * Real-time /challenges results table. Initial rows come from the server
 * (SSR), then the component polls /api/challenges every 5s with the page's
 * active filters and replaces the list. Newly-arrived rows fade in for ~1.5s
 * so it's visible the table is streaming — the exact same polling logic as
 * RecentChallengesTable on the Performance page (same interval, same diff +
 * highlight, same per-second relative-time tick).
 *
 * Scaling: the API route is cached server-side for 10s + edge-cached for 5s,
 * so N concurrent polling clients on a filter set converge to ~1 DB query /
 * 10s. See apps/web/src/app/api/challenges/route.ts.
 */

import { useEffect, useRef, useState } from "react";
import { BucketTags } from "@/components/BucketTags";
import { ChallengeTarget } from "@/components/ChallengeTarget";
import { ClickableRow } from "@/components/ClickableRow";
import { ConsensusSummary, type ConsensusCounts } from "@/components/ConsensusSummary";
import {
  STATUS_OPTIONS,
  type ChallengeRow,
  type ChallengesFilters,
} from "@/lib/challengeFilters";

const POLL_INTERVAL_MS = 5_000;
const HIGHLIGHT_DURATION_MS = 1_800;
const RELATIVE_TIME_TICK_MS = 1_000;

function fmtRelativeTime(t: string | Date): string {
  const ts = (typeof t === "string" ? new Date(t) : t).getTime();
  const dt = (Date.now() - ts) / 1000;
  if (dt < 60) return `${Math.max(1, Math.floor(dt))}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

function pollUrl(f: ChallengesFilters): string {
  const qs = new URLSearchParams();
  if (f.method) qs.set("method", f.method);
  if (f.bucket) qs.set("bucket", f.bucket);
  if (f.status) qs.set("status", f.status);
  qs.set("window", String(f.window));
  if (f.target) qs.set("target", f.target);
  if (f.offset > 0) qs.set("offset", String(f.offset));
  return `/api/challenges?${qs.toString()}`;
}

export function ChallengesTable({
  initial,
  filters,
  emptyText,
}: {
  initial: ChallengeRow[];
  filters: ChallengesFilters;
  emptyText: string;
}) {
  const [rows, setRows] = useState<ChallengeRow[]>(initial);
  // IDs of rows that just arrived this tick — animate a brief highlight so
  // it's obvious which rows are new.
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  // Force a re-render every second so the "X seconds ago" column ticks
  // continuously instead of jumping every 5s when the poll fires.
  const [, setTick] = useState(0);
  // Seed the "known IDs" set with the initial server-rendered batch so the
  // first poll doesn't flash everything as "new".
  const knownIdsRef = useRef<Set<string>>(new Set(initial.map((c) => c.id)));

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const url = pollUrl(filters);
  useEffect(() => {
    let cancelled = false;
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as ChallengeRow[];
        if (cancelled) return;

        // Diff against the previous tick's IDs (not the SSR seed) so a row
        // that's been there for 10s doesn't keep flashing.
        const arrived: string[] = [];
        for (const c of data) {
          if (!knownIdsRef.current.has(c.id)) arrived.push(c.id);
        }
        knownIdsRef.current = new Set(data.map((c) => c.id));
        setRows(data);

        if (arrived.length > 0) {
          setNewIds((prev) => {
            const next = new Set(prev);
            for (const id of arrived) next.add(id);
            return next;
          });
          // Clear the highlight after the animation completes.
          if (highlightTimer) clearTimeout(highlightTimer);
          highlightTimer = setTimeout(() => {
            if (cancelled) return;
            setNewIds((prev) => {
              const next = new Set(prev);
              for (const id of arrived) next.delete(id);
              return next;
            });
          }, HIGHLIGHT_DURATION_MS);
        }
      } catch {
        // Swallow — next interval will retry. Fetch failures during a deploy
        // or transient network blip shouldn't surface as a broken UI.
      }
    };

    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (highlightTimer) clearTimeout(highlightTimer);
    };
  }, [url]);

  if (rows.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--muted)", padding: 12 }}>{emptyText}</p>;
  }

  const rowClass = (id: string) => (newIds.has(id) ? "recent-row-flash" : undefined);

  return (
    <div className="prov-table-wrap is-scroll" style={{ maxHeight: 560 }}>
      <table className="prov-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 980 }}>
        <colgroup>
          <col style={{ width: 210 }} />
          <col style={{ width: 250 }} />
          <col style={{ width: 180 }} />
          <col style={{ width: 110 }} />
          {/* Compact consensus chip — see ConsensusSummary.tsx. 120px is
              plenty even at worst-case "220 · 220 · 220". */}
          <col style={{ width: 120 }} />
          <col style={{ width: 80 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Method</th>
            <th>Bucket</th>
            <th>Target</th>
            <th>Status</th>
            <th>Consensus</th>
            <th className="prov-num">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const counts: ConsensusCounts = {
              total: c.total,
              correct: c.correct,
              ambiguous: c.ambiguous,
              incorrect: c.incorrect,
              disputed: c.disputed,
            };
            return (
              <ClickableRow key={c.id} href={`/raw?challenge=${c.id}`} className={rowClass(c.id)}>
                <td>
                  <code className="prov-ch-method">{c.method}</code>
                </td>
                <td>
                  <BucketTags raw={c.bucket} />
                </td>
                <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <ChallengeTarget method={c.method} params={c.params} />
                </td>
                <td>
                  <code
                    style={{
                      fontSize: 11,
                      color: c.status === "ready" ? "#7be0a4" : "var(--text-2)",
                    }}
                  >
                    {STATUS_OPTIONS.find((s) => s.value === c.status)?.label ?? c.status}
                  </code>
                </td>
                <td>
                  <ConsensusSummary counts={counts} />
                </td>
                <td className="prov-num prov-ch-when">{fmtRelativeTime(c.generated_at)}</td>
              </ClickableRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
