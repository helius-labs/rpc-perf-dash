"use client";

/**
 * Real-time recent-challenges table. Initial rows come from the server (SSR),
 * then the component polls /api/recent-challenges every 5s and replaces the
 * list. Newly-arrived rows fade in for ~1.5s so it's visible the table is
 * streaming.
 *
 * Scaling: the API route is cached server-side for 10s + edge-cached for 5s,
 * so N concurrent polling clients converge to 1 DB query / 10s regardless of
 * audience size. See apps/web/src/app/api/recent-challenges/route.ts.
 *
 * "Just dispatched" rows correctly show `—` in the Consensus chip until
 * workers finish their fanout (~30s) and samples land. Watching the chip
 * populate is the visible signal that the system is working live.
 */

import { useEffect, useRef, useState } from "react";
import { BucketTags } from "@/components/BucketTags";
import { ChallengeTarget } from "@/components/ChallengeTarget";
import { ClickableCard, ClickableRow } from "@/components/ClickableRow";
import { ConsensusSummary } from "@/components/ConsensusSummary";
import { FloatingTooltip } from "@/components/FloatingTooltip";
import type { RecentChallenge } from "@/lib/recentChallenges";

const POLL_INTERVAL_MS = 5_000;
const HIGHLIGHT_DURATION_MS = 1_800;
const RELATIVE_TIME_TICK_MS = 1_000;

const CHALLENGE_STATUS_STYLE: Record<
  string,
  { bg: string; fg: string; label: string; description: string }
> = {
  ready: {
    bg: "#0e2a18",
    fg: "#7be0a4",
    label: "dispatched",
    description:
      "Challenge written and assignments fanned out. Dispatch only: it does not mean consensus was reached. See the per-row consensus counts, or open /raw, for the actual result.",
  },
  expired: {
    bg: "#2a1010",
    fg: "#f08080",
    label: "expired",
    description:
      "Challenge didn't resolve in time. Usually means the auditor was unreachable or vantages weren't claiming assignments.",
  },
};

function fmtRelativeTime(t: string | Date): string {
  const ts = (typeof t === "string" ? new Date(t) : t).getTime();
  const dt = (Date.now() - ts) / 1000;
  if (dt < 60) return `${Math.max(1, Math.floor(dt))}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

function ChallengeStatusBadge({ status }: { status: string }) {
  const s = CHALLENGE_STATUS_STYLE[status] ?? {
    bg: "#1a1a1a",
    fg: "#aaa",
    label: status,
    description: `Unknown status: ${status}`,
  };
  return (
    <FloatingTooltip
      trigger={
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 3,
            background: s.bg,
            color: s.fg,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            cursor: "help",
          }}
        >
          {s.label}
        </span>
      }
    >
      <div className="font-medium mb-1" style={{ color: s.fg }}>
        {s.label}
      </div>
      <div className="text-neutral-300">{s.description}</div>
    </FloatingTooltip>
  );
}

export function RecentChallengesTable({
  initial,
  limit = 20,
}: {
  initial: RecentChallenge[];
  limit?: number;
}) {
  const [challenges, setChallenges] = useState<RecentChallenge[]>(initial);
  // IDs of rows that just arrived this tick — animate a brief highlight so
  // it's obvious which rows are new.
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  // Force a re-render every second so the "X seconds ago" column ticks
  // continuously instead of jumping every 5s when the poll fires. The
  // counter value itself is unused — fmtRelativeTime reads Date.now() at
  // render time, so a re-render is enough to refresh every cell.
  const [, setTick] = useState(0);
  // Seed the "known IDs" set with the initial server-rendered batch so the
  // first poll doesn't flash everything as "new".
  const knownIdsRef = useRef<Set<string>>(new Set(initial.map((c) => c.id)));

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let highlightTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const r = await fetch(`/api/recent-challenges?limit=${limit}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const data = (await r.json()) as RecentChallenge[];
        if (cancelled) return;

        // Diff against the previous tick's IDs (not the SSR seed) so a row
        // that's been there for 10s doesn't keep flashing.
        const arrived: string[] = [];
        for (const c of data) {
          if (!knownIdsRef.current.has(c.id)) arrived.push(c.id);
        }
        knownIdsRef.current = new Set(data.map((c) => c.id));
        setChallenges(data);

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
  }, [limit]);

  if (challenges.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--muted)", padding: 12 }}>
        No challenges generated in the last hour. The generator may be down; check ECS.
      </p>
    );
  }

  const rowClass = (id: string) =>
    newIds.has(id) ? "recent-row-flash" : undefined;

  return (
    <>
      {/* Desktop: wide table. */}
      <div className="hidden md:block">
        <table className="prov-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 1040 }}>
          <colgroup>
            <col style={{ width: 210 }} />
            <col style={{ width: 250 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 80 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Method</th>
              <th>Bucket</th>
              <th>Target</th>
              <th>
                <FloatingTooltip
                  title="Challenge status"
                  trigger={
                    <span style={{ borderBottom: "1px dotted var(--border-2)", cursor: "help" }}>Status</span>
                  }
                >
                  <div className="font-medium mb-1.5">Challenge status</div>
                  <div className="flex flex-col gap-1.5">
                    <div>
                      <span className="text-emerald-300 font-medium">dispatched</span>
                      <span className="text-neutral-400">: written and fanned out to vantages. Not a consensus verdict; see the consensus column or /raw for that.</span>
                    </div>
                    <div>
                      <span className="text-neutral-300 font-medium">expired</span>
                      <span className="text-neutral-400">: didn&apos;t resolve in time (auditor unreachable, no vantages claimed, or past TTL).</span>
                    </div>
                  </div>
                </FloatingTooltip>
              </th>
              <th className="prov-num">n samples</th>
              <th>
                <FloatingTooltip
                  title="Consensus"
                  trigger={
                    <span style={{ borderBottom: "1px dotted var(--border-2)", cursor: "help" }}>Consensus</span>
                  }
                >
                  <div className="font-medium mb-1.5">Consensus</div>
                  <div className="text-neutral-400 mb-2">Aggregated per-sample outcome counts.</div>
                  <div className="flex flex-col gap-1">
                    <div><span className="text-emerald-300">●</span> <span className="text-neutral-200">all correct</span></div>
                    <div><span className="text-amber-300">●</span> <span className="text-neutral-200">some ambiguous</span> <span className="text-neutral-500">(no consensus or auditor-disputed)</span></div>
                    <div><span className="text-red-300">●</span> <span className="text-neutral-200">some incorrect</span></div>
                    <div><span className="text-neutral-500">●</span> <span className="text-neutral-200">no samples yet</span></div>
                  </div>
                </FloatingTooltip>
              </th>
              <th className="prov-num">When</th>
            </tr>
          </thead>
          <tbody>
            {challenges.map((c) => (
              <ClickableRow
                key={c.id}
                href={`/raw?challenge=${c.id}`}
                className={rowClass(c.id)}
              >
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
                  <ChallengeStatusBadge status={c.status} />
                </td>
                <td className="prov-num">{c.sample_count}</td>
                <td>
                  <ConsensusSummary
                    counts={{
                      total: c.sample_count,
                      correct: c.consensus_correct,
                      ambiguous: c.consensus_ambiguous,
                      incorrect: c.consensus_incorrect,
                      disputed: c.consensus_disputed,
                    }}
                  />
                </td>
                <td className="prov-num prov-ch-when">{fmtRelativeTime(c.generated_at)}</td>
              </ClickableRow>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards. */}
      <div className="md:hidden flex flex-col" style={{ gap: 8, padding: 8 }}>
        {challenges.map((c) => (
          <ClickableCard
            key={c.id}
            href={`/raw?challenge=${c.id}`}
            className={rowClass(c.id)}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <code className="prov-ch-method" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {c.method}
              </code>
              <ChallengeStatusBadge status={c.status} />
            </div>
            <div style={{ marginBottom: 6 }}>
              <BucketTags raw={c.bucket} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis" }}>
              <ChallengeTarget method={c.method} params={c.params} />
            </div>
            <div style={{ marginBottom: 6 }}>
              <ConsensusSummary
                counts={{
                  total: c.sample_count,
                  correct: c.consensus_correct,
                  ambiguous: c.consensus_ambiguous,
                  incorrect: c.consensus_incorrect,
                  disputed: c.consensus_disputed,
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 11,
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span>{c.sample_count}n</span>
              <span>{fmtRelativeTime(c.generated_at)}</span>
            </div>
          </ClickableCard>
        ))}
      </div>
    </>
  );
}
