import { sql } from "drizzle-orm";
import Link from "next/link";
import type { Route } from "next";
import { unstable_cache } from "next/cache";
import { db, DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface RunSummary {
  run_id: string;
  started_at: string | Date;
  ended_at: string | Date;
  total_challenges: number;
  consensus_challenges: number;
  ambiguous_challenges: number;
  total_samples: number;
}

async function fetchRunsImpl(): Promise<RunSummary[]> {
  // (a) Top-50 runs from `challenges` alone — uses challenges_run_id_idx, never
  // touches the high-volume samples table.
  const runRows = (await db().execute(sql`
    SELECT
      c.run_id::text          AS run_id,
      min(c.generated_at)     AS started_at,
      max(c.generated_at)     AS ended_at,
      count(*)::int           AS total_challenges,
      count(*) FILTER (WHERE c.status = 'ready')::int     AS consensus_challenges,
      count(*) FILTER (WHERE c.status = 'ambiguous')::int AS ambiguous_challenges
    FROM challenges c
    WHERE c.run_id IS NOT NULL
    GROUP BY c.run_id
    ORDER BY max(c.generated_at) DESC
    LIMIT 50
  `)) as unknown as Array<Omit<RunSummary, "total_samples">>;
  if (runRows.length === 0) return [];

  // (b) Sample counts for ONLY those ≤50 runs, reaching samples via
  // challenge_id (samples_challenge_idx). Replaces the old per-challenge LATERAL
  // that fanned out across ALL run challenges. Literal IN-list — postgres.js
  // (Neon pooler, prepare:false) rejects `= ANY($arr)`; uuids need no escaping
  // but we escape defensively, same convention as chartData/leaderboard.
  const idLiteral = sql.raw(
    runRows.map((r) => `'${r.run_id.replace(/'/g, "''")}'`).join(","),
  );
  const sampleRows = (await db().execute(sql`
    SELECT c.run_id::text AS run_id, count(s.*)::int AS total_samples
    FROM challenges c
    JOIN samples s ON s.challenge_id = c.id
    WHERE c.run_id IN (${idLiteral})
    GROUP BY c.run_id
  `)) as unknown as Array<{ run_id: string; total_samples: number }>;

  // (c) Merge — `?? 0` reproduces the old coalesce(sum(...), 0) for runs whose
  // challenges produced no samples (dropped by the inner JOIN). Order from (a)
  // (most-recent-first) is preserved.
  const byRun = new Map(sampleRows.map((r) => [r.run_id, r.total_samples]));
  return runRows.map((r) => ({ ...r, total_samples: byRun.get(r.run_id) ?? 0 }));
}

// Runs are produced by the `pnpm benchmark` CLI and change rarely. Cache so
// repeat visits / refreshes inside the window don't re-run the queries. 30s is
// generous given how seldom new runs land. (Note: with the 30-day challenges
// retention, runs older than 30d no longer appear here.)
const fetchRuns = unstable_cache(fetchRunsImpl, ["fetchRuns"], { revalidate: 30 });

export default async function RunsPage() {
  let runs: RunSummary[] = [];
  let error: string | null = null;
  try {
    runs = await fetchRuns();
  } catch (err) {
    console.error("[/runs]", err);
    error = DB_ERROR_MESSAGE;
  }

  return (
    <div>
      <h1>Benchmark runs</h1>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
        Each row is one <code>pnpm benchmark</code> run. Continuous-mode samples are not listed here.
      </p>

      {error && (
        <div className="badge bad block p-3">
          DB error: {error}
        </div>
      )}

      {!error && runs.length === 0 && (
        <p style={{ color: "#888" }}>No tagged runs yet. Run <code>pnpm benchmark</code> to create one.</p>
      )}

      {runs.length > 0 && (
        <>
          {/* Desktop: wide table */}
          <div className="hidden md:block overflow-auto">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Challenges</th>
                  <th>Consensus</th>
                  <th>Ambiguous</th>
                  <th>Samples</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const started = new Date(r.started_at);
                  const ended = new Date(r.ended_at);
                  const durationSec = Math.max(1, Math.round((ended.getTime() - started.getTime()) / 1000));
                  const minutes = Math.floor(durationSec / 60);
                  const seconds = durationSec % 60;
                  return (
                    <tr key={r.run_id}>
                      <td><code>{r.run_id.slice(0, 8)}</code></td>
                      <td>{started.toISOString().replace("T", " ").slice(0, 19)}Z</td>
                      <td>{minutes > 0 ? `${minutes}m ` : ""}{seconds}s</td>
                      <td>{r.total_challenges}</td>
                      <td>{r.consensus_challenges}</td>
                      <td>{r.ambiguous_challenges}</td>
                      <td>{r.total_samples}</td>
                      <td><Link href={`/run/${r.run_id}` as Route} style={{ fontSize: 12 }}>details →</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="md:hidden flex flex-col gap-2">
            {runs.map((r) => {
              const started = new Date(r.started_at);
              const ended = new Date(r.ended_at);
              const durationSec = Math.max(1, Math.round((ended.getTime() - started.getTime()) / 1000));
              const minutes = Math.floor(durationSec / 60);
              const seconds = durationSec % 60;
              return (
                <Link
                  key={r.run_id}
                  href={`/run/${r.run_id}` as Route}
                  style={{
                    display: "block",
                    background: "#0c0c0c",
                    border: "1px solid #1f1f1f",
                    borderRadius: 6,
                    padding: 12,
                    color: "inherit",
                    textDecoration: "none",
                  }}
                >
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <code style={{ fontSize: 12, color: "#eaeaea" }}>{r.run_id.slice(0, 8)}</code>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "#888", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                      {started.toISOString().replace("T", " ").slice(0, 19)}Z
                    </span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, color: "#888" }}>
                    <span>{minutes > 0 ? `${minutes}m ` : ""}{seconds}s</span>
                    <span>{r.total_challenges} ch</span>
                    <span style={{ color: "#7be0a4" }}>{r.consensus_challenges} ok</span>
                    <span style={{ color: "#f3c27a" }}>{r.ambiguous_challenges} amb</span>
                    <span>{r.total_samples} samples</span>
                    <span style={{ marginLeft: "auto", color: "#3aa3ff" }}>details →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
