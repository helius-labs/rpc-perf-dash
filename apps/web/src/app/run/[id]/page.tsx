import { sql } from "drizzle-orm";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import {
  BENCHMARKED_PROVIDERS,
  DEFAULT_WEIGHTS,
  METHODOLOGY_VERSION,
  score,
} from "@rpcbench/shared";
import { db } from "@/lib/db";
import { BucketTags } from "@/components/BucketTags";

export const dynamic = "force-dynamic";

interface RunMeta {
  run_id: string;
  started_at: string | Date;
  ended_at: string | Date;
  total_challenges: number;
  consensus_challenges: number;
  ambiguous_challenges: number;
  region: string | null;
}

interface ProviderRow {
  provider_id: string;
  n_total: number;
  n_correct: number;
  p50_cold: number | null;
  p95_cold: number | null;
  p99_cold: number | null;
  p50_warm: number | null;
  p95_warm: number | null;
  p99_warm: number | null;
  success_rate: number;
  correctness_rate: number;
  freshness_p95_lag: number | null;
  n_wins: number;
  n_challenges_with_winner: number;
}

interface ChallengeRow {
  id: string;
  method: string;
  bucket: string;
  status: string;
  generated_at: string | Date;
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return (
      <div className="badge bad" style={{ display: "block", padding: 12 }}>
        Invalid run ID: must be a UUID.
      </div>
    );
  }

  let meta: RunMeta | null = null;
  let perProvider: ProviderRow[] = [];
  let challenges: ChallengeRow[] = [];
  let error: string | null = null;

  try {
    const metaRows = await db().execute(sql`
      SELECT
        c.run_id::text                                       AS run_id,
        min(c.generated_at)                                  AS started_at,
        max(c.generated_at)                                  AS ended_at,
        count(*)::int                                        AS total_challenges,
        count(*) FILTER (WHERE c.status = 'ready')::int      AS consensus_challenges,
        count(*) FILTER (WHERE c.status = 'ambiguous')::int  AS ambiguous_challenges,
        (SELECT region FROM samples WHERE challenge_id = (
          SELECT id FROM challenges WHERE run_id = ${id}::uuid LIMIT 1
        ) LIMIT 1)                                            AS region
      FROM challenges c
      WHERE c.run_id = ${id}::uuid
      GROUP BY c.run_id
    `);
    meta = (metaRows as unknown as RunMeta[])[0] ?? null;
    if (!meta) notFound();

    const provRows = await db().execute(sql`
      WITH agg AS (
        SELECT
          s.provider_id,
          count(*)::int                                                                              AS n_total,
          count(*) FILTER (WHERE s.correctness = 'correct')::int                                     AS n_correct,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.connection_mode='cold' AND s.correctness='correct')::int AS p50_cold,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.connection_mode='cold' AND s.correctness='correct')::int AS p95_cold,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.connection_mode='cold' AND s.correctness='correct')::int AS p99_cold,
          percentile_cont(0.50) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.connection_mode='warm' AND s.correctness='correct')::int AS p50_warm,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.connection_mode='warm' AND s.correctness='correct')::int AS p95_warm,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY s.latency_ms) FILTER (WHERE s.connection_mode='warm' AND s.correctness='correct')::int AS p99_warm,
          avg(CASE WHEN s.status = 'ok' AND s.correctness != 'ambiguous' THEN 1.0 ELSE 0.0 END)::real AS success_rate,
          (count(*) FILTER (WHERE s.status = 'ok' AND s.correctness = 'correct')::real
           / NULLIF(count(*) FILTER (WHERE s.status = 'ok' AND s.correctness IN ('correct', 'incorrect', 'stale'))::real, 0))::real AS correctness_rate,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY s.freshness_lag) FILTER (WHERE s.correctness='correct')::int AS freshness_p95_lag
        FROM samples s
        WHERE s.challenge_id IN (SELECT id FROM challenges WHERE run_id = ${id}::uuid)
          AND s.methodology_version = ${METHODOLOGY_VERSION}
        GROUP BY s.provider_id
      ),
      -- One winner per challenge: lowest-latency correct cold sample. Scoped to
      -- this run only. Score uses cold p95, so wins are likewise cold-mode.
      challenge_winners AS (
        SELECT DISTINCT ON (s.challenge_id) s.challenge_id, s.provider_id
        FROM samples s
        WHERE s.challenge_id IN (SELECT id FROM challenges WHERE run_id = ${id}::uuid)
          AND s.methodology_version = ${METHODOLOGY_VERSION}
          AND s.connection_mode = 'cold'
          AND s.correctness = 'correct'
        ORDER BY s.challenge_id, s.latency_ms ASC
      ),
      win_counts AS (
        SELECT provider_id, count(*)::int AS n_wins FROM challenge_winners GROUP BY provider_id
      ),
      win_total AS (
        SELECT count(*)::int AS n_challenges_with_winner FROM challenge_winners
      )
      SELECT
        a.*,
        coalesce(w.n_wins, 0)                                AS n_wins,
        (SELECT n_challenges_with_winner FROM win_total)     AS n_challenges_with_winner
      FROM agg a
      LEFT JOIN win_counts w ON w.provider_id = a.provider_id
    `);
    perProvider = provRows as unknown as ProviderRow[];

    const cRows = await db().execute(sql`
      SELECT id::text AS id, method, bucket, status, generated_at
      FROM challenges WHERE run_id = ${id}::uuid
      ORDER BY generated_at
    `);
    challenges = cRows as unknown as ChallengeRow[];
  } catch (err) {
    error = (err as Error).message;
    console.error("[/run]", err);
  }

  if (error) {
    return <div className="badge bad" style={{ display: "block", padding: 12 }}>DB error: {error}</div>;
  }
  if (!meta) return <div>Run not found.</div>;

  // Score the providers using the same formula as the leaderboard.
  const eligible = perProvider.filter(
    (p) => p.n_correct > 0 && p.p95_cold !== null && p.p50_cold !== null,
  );
  const scored = score(
    eligible.map((p) => ({
      provider_id: p.provider_id,
      p50_latency_ms: p.p50_cold!,
      p95_latency_ms: p.p95_cold!,
      success_rate: p.success_rate,
      correct_count: p.n_correct,
      validated_count: p.n_correct,
      freshness_p95_lag: p.freshness_p95_lag ?? 1,
      n_wins: p.n_wins ?? 0,
      n_challenges_with_winner: p.n_challenges_with_winner ?? 0,
    })),
  ).sort((a, b) => b.total - a.total);

  const startedAt = new Date(meta.started_at);
  const endedAt = new Date(meta.ended_at);
  const durationSec = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));

  return (
    <div>
      <Link href="/runs" style={{ fontSize: 13 }}>← All runs</Link>
      <h1>Run <code>{meta.run_id.slice(0, 8)}</code></h1>
      <table style={{ marginBottom: 24 }}>
        <tbody>
          <tr><td>Started</td><td>{startedAt.toISOString()}</td></tr>
          <tr><td>Ended</td><td>{endedAt.toISOString()}</td></tr>
          <tr><td>Duration</td><td>{Math.floor(durationSec / 60)}m {durationSec % 60}s</td></tr>
          <tr><td>Region</td><td>{meta.region ?? "—"}</td></tr>
          <tr>
            <td>Challenges</td>
            <td>
              {meta.total_challenges} total ·
              {" "}{meta.consensus_challenges} consensus ·
              {" "}{meta.ambiguous_challenges} ambiguous ·
              {" "}{meta.total_challenges - meta.consensus_challenges - meta.ambiguous_challenges} other
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Per-provider results</h2>
      <div style={{ overflowX: "auto" }}>
      <table style={{ minWidth: 720 }}>
        <thead>
          <tr>
            <th>#</th>
            <th>Provider</th>
            <th>Score</th>
            <th>p50 cold</th>
            <th>p95 cold</th>
            <th>p50 warm</th>
            <th>p95 warm</th>
            <th>n total</th>
            <th>correct%</th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            const scoreById = new Map(scored.map((s) => [s.provider_id, s]));
            const rows = perProvider.map((p) => ({ p, s: scoreById.get(p.provider_id) ?? null }));
            rows.sort((a, b) => (b.s?.total ?? -1) - (a.s?.total ?? -1));
            return rows.map(({ p, s }, idx) => {
              const provider = BENCHMARKED_PROVIDERS.find((bp) => bp.id === p.provider_id);
              return (
                <tr key={p.provider_id}>
                  <td>{s ? idx + 1 : "—"}</td>
                  <td>{provider?.name ?? p.provider_id}</td>
                  <td>{s ? <strong>{s.total.toFixed(1)}</strong> : <span className="badge bad">ineligible</span>}</td>
                  <td>{p.p50_cold != null ? `${p.p50_cold}ms` : "—"}</td>
                  <td>{p.p95_cold != null ? `${p.p95_cold}ms` : "—"}</td>
                  <td>{p.p50_warm != null ? `${p.p50_warm}ms` : "—"}</td>
                  <td>{p.p95_warm != null ? `${p.p95_warm}ms` : "—"}</td>
                  <td>{p.n_total}</td>
                  <td>{(p.correctness_rate * 100).toFixed(1)}%</td>
                </tr>
              );
            });
          })()}
        </tbody>
      </table>
      </div>

      <p style={{ fontSize: 13, color: "#888", marginTop: 8 }}>
        Score = {DEFAULT_WEIGHTS.latency} L + {DEFAULT_WEIGHTS.winRate} W + {DEFAULT_WEIGHTS.reliability} R +
        {" "}{DEFAULT_WEIGHTS.correctness} C + {DEFAULT_WEIGHTS.freshness} F. L blends p50 and p95 cold latency; W is
        the share of this run&apos;s challenges where this provider had the lowest-latency correct cold sample,
        normalized to the best winner. Cold/warm latency filters to <code>correctness=correct</code> samples only,
        so timeouts and errors don&apos;t pollute the percentiles.
      </p>

      <h2>Challenges in this run ({challenges.length})</h2>
      <ChallengesTable challenges={challenges} runStart={startedAt} />
    </div>
  );
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  ready:        { bg: "#0e2a18", fg: "#7be0a4", label: "ready" },
  ambiguous:    { bg: "#2a1f0e", fg: "#f3c27a", label: "ambiguous" },
  in_progress:  { bg: "#1a1f2a", fg: "#9bb8e0", label: "in progress" },
  expired:      { bg: "#2a1010", fg: "#f08080", label: "expired" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { bg: "#1a1a1a", fg: "#aaa", label: status };
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: 3,
        background: s.bg,
        color: s.fg,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      {s.label}
    </span>
  );
}

function fmtOffset(genAt: Date, runStart: Date): string {
  const dt = (genAt.getTime() - runStart.getTime()) / 1000;
  if (dt < 60) return `+${dt.toFixed(1)}s`;
  const m = Math.floor(dt / 60);
  const s = dt - m * 60;
  return `+${m}m${s.toFixed(0).padStart(2, "0")}s`;
}

function ChallengesTable({
  challenges,
  runStart,
}: {
  challenges: ChallengeRow[];
  runStart: Date;
}) {
  if (challenges.length === 0) {
    return <p style={{ fontSize: 13, color: "#888" }}>No challenges in this run.</p>;
  }
  // Group by method for visual structure.
  const byMethod = new Map<string, ChallengeRow[]>();
  for (const c of challenges) {
    const arr = byMethod.get(c.method) ?? [];
    arr.push(c);
    byMethod.set(c.method, arr);
  }
  return (
    <div style={{ marginBottom: 24 }}>
      {[...byMethod.entries()].map(([method, rows]) => {
        const ready = rows.filter((r) => r.status === "ready").length;
        const ambig = rows.filter((r) => r.status === "ambiguous").length;
        return (
          <div key={method} style={{ marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 4,
              }}
            >
              <code style={{ fontSize: 13, fontWeight: 600 }}>{method}</code>
              <span style={{ fontSize: 11, color: "#888" }}>
                {rows.length} total · {ready} ready · {ambig} ambiguous
              </span>
            </div>
            <table style={{ width: "100%", fontSize: 12, tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "60%" }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 60 }} />
              </colgroup>
              <thead>
                <tr style={{ color: "#888" }}>
                  <th style={{ textAlign: "left", fontWeight: 400 }}>Bucket</th>
                  <th style={{ textAlign: "left", fontWeight: 400 }}>Status</th>
                  <th style={{ textAlign: "right", fontWeight: 400 }}>Offset</th>
                  <th style={{ textAlign: "right", fontWeight: 400 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} style={{ borderTop: "1px solid #1a1a1a" }}>
                    <td style={{ paddingTop: 6, paddingBottom: 6 }}>
                      <BucketTags raw={c.bucket} />
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td
                      style={{
                        textAlign: "right",
                        color: "#888",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {fmtOffset(new Date(c.generated_at), runStart)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link href={`/raw?challenge=${c.id}` as Route} style={{ fontSize: 11 }}>raw →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
