import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { WORKER_PROVIDER_LABELS } from "@rpcbench/shared";
import { db } from "@/lib/db";

/**
 * Derive-on-read pipeline health for the /status page. No new tables: every
 * signal here is computed from the existing timestamp columns on `challenges`,
 * `challenge_assignments`, `samples`, and the heartbeat tables.
 *
 * The design treats the system as a FUNNEL — generator dispatches → challenges
 * carry a valid TTL → workers claim → workers write samples. A healthy pipeline
 * is green at every stage; the FIRST red stage is the broken link. This is what
 * the binary "is data arriving" dot couldn't tell us during the 2026-05-29
 * clock-skew outage, when the generator + workers were both alive and only the
 * claim→sample step silently produced nothing.
 */

export type StageState = "ok" | "warn" | "down" | "unknown";

export interface PipelineStage {
  key: string;
  label: string;
  state: StageState;
  /** Primary metric line (e.g. "~590 / min"). */
  metric: string;
  /** Seconds since this stage last produced (null = never in window). */
  lastSeenAgeS: number | null;
  /** Short explanation shown under the stage. */
  detail: string;
}

export interface CloudRow {
  worker_provider: string;
  label: string;
  state: StageState;
  hbAgeS: number | null;
  nWorkers: number;
  claimed5m: number;
  sampled5m: number;
  sampleAgeS: number | null;
  /** Absolute timestamps so the client can tick the "Ns ago" displays live. */
  lastBeatIso: string | null;
  lastSampleIso: string | null;
}

export interface TimelinePoint {
  label: string;
  dispatched: number;
  claimed: number;
  sampled: number;
}

export interface PipelineStatus {
  overall: StageState;
  stages: PipelineStage[];
  clouds: CloudRow[];
  auditorUnavailPct: number | null;
  generatedAtIso: string;
}

interface FunnelRow {
  dispatched_5m: number;
  ttl_avg_s: number | null;
  ttl_min_s: number | null;
  dispatch_age_s: number | null;
  claimed_5m: number;
  claim_age_s: number | null;
  sampled_5m: number;
  sample_age_s: number | null;
  gen_hb_age_s: number | null;
  auditor_unavail_pct: number | null;
}

/**
 * 24h timeline sparkline (dispatched / claimed / sampled per 15 min). The only
 * long-window scan in /status — cached 60s and fetched separately so it never
 * blocks or freezes the live funnel + cloud matrix. History tolerates 60s
 * staleness; if revalidation stalls it degrades to a stale sparkline only.
 */
async function fetchTimelineImpl(): Promise<TimelinePoint[]> {
  return (await db().execute(sql`
    WITH b AS (
      SELECT generate_series(
        date_trunc('hour', now()) - interval '24 hours',
        date_trunc('hour', now()) + interval '15 min',
        interval '15 min') AS ts
    ),
    d AS (SELECT date_trunc('hour', generated_at) + floor(extract(minute from generated_at)/15)*interval '15 min' AS ts, count(*)::int n
          FROM challenges WHERE generated_at > now() - interval '24 hours' GROUP BY 1),
    c AS (SELECT date_trunc('hour', claimed_at) + floor(extract(minute from claimed_at)/15)*interval '15 min' AS ts, count(*)::int n
          FROM challenge_assignments WHERE claimed_at > now() - interval '24 hours' GROUP BY 1),
    s AS (SELECT date_trunc('hour', started_at) + floor(extract(minute from started_at)/15)*interval '15 min' AS ts, count(*)::int n
          FROM samples WHERE started_at > now() - interval '24 hours' GROUP BY 1)
    SELECT to_char(b.ts, 'MM-DD HH24:MI') AS label,
      coalesce(d.n, 0) AS dispatched, coalesce(c.n, 0) AS claimed, coalesce(s.n, 0) AS sampled
    FROM b
    LEFT JOIN d ON d.ts = b.ts LEFT JOIN c ON c.ts = b.ts LEFT JOIN s ON s.ts = b.ts
    ORDER BY b.ts
  `)) as unknown as TimelinePoint[];
}

/**
 * The 24h sparkline. Exported + cached 60s, and rendered behind its own Suspense
 * boundary on /status (see StatusTimelineSection) so this — the one unavoidable
 * long scan over challenges/assignments/samples — never blocks the live funnel +
 * cloud matrix from painting. History tolerates 60s staleness.
 */
export const fetchTimeline = unstable_cache(fetchTimelineImpl, ["statusTimeline"], { revalidate: 60 });

async function fetchPipelineStatusImpl(): Promise<PipelineStatus> {
  // One round-trip for the funnel: 5-min rates (cheap, indexed recent slice),
  // the TTL invariant, and a 24h-bounded "last seen" per stage so a stalled
  // stage reports exactly how long ago it last produced.
  const funnelRows = (await db().execute(sql`
    SELECT
      (SELECT count(*) FROM challenges WHERE generated_at > now() - interval '5 min')::int          AS dispatched_5m,
      (SELECT round(avg(extract(epoch from expires_at - generated_at))::numeric, 1)
         FROM challenges WHERE generated_at > now() - interval '5 min')                              AS ttl_avg_s,
      (SELECT round(min(extract(epoch from expires_at - generated_at))::numeric, 1)
         FROM challenges WHERE generated_at > now() - interval '5 min')                              AS ttl_min_s,
      -- "last seen" bounded to 15 min, not 24h. The samples/assignments tables
      -- are high-volume (37 methods × fanout) with no standalone time index, so
      -- a 24h max()-scan was 2–15s and blew the cache-revalidation budget,
      -- freezing the page on a >1d-old snapshot. A 15-min recent slice is
      -- partition-pruned and fast; a >15-min gap already means the stage is
      -- down (age → null) — and down-detection uses the 5-min count, not the age.
      (SELECT extract(epoch from now() - max(generated_at))::int
         FROM challenges WHERE generated_at > now() - interval '15 min')                             AS dispatch_age_s,
      (SELECT count(*) FROM challenge_assignments WHERE claimed_at > now() - interval '5 min')::int  AS claimed_5m,
      (SELECT extract(epoch from now() - max(claimed_at))::int
         FROM challenge_assignments WHERE claimed_at > now() - interval '15 min')                    AS claim_age_s,
      (SELECT count(*) FROM samples WHERE started_at > now() - interval '5 min')::int                AS sampled_5m,
      (SELECT extract(epoch from now() - max(started_at))::int
         FROM samples WHERE started_at > now() - interval '15 min')                                  AS sample_age_s,
      (SELECT extract(epoch from now() - max(beat_at))::int FROM generator_heartbeat)                AS gen_hb_age_s,
      (SELECT round((count(*) FILTER (WHERE exclusion_reason = 'auditor_unavailable')::numeric
                     / nullif(count(*), 0)) * 100, 1)
         FROM samples WHERE started_at > now() - interval '15 min')                                  AS auditor_unavail_pct
  `)) as unknown as FunnelRow[];
  const f = funnelRows[0]!;

  // Per-cloud matrix: is it all clouds at once (shared cause) or one lane?
  const cloudRows = (await db().execute(sql`
    WITH clouds AS (
      SELECT DISTINCT worker_provider FROM worker_heartbeat WHERE beat_at > now() - interval '30 min'
    ),
    hb AS (
      SELECT worker_provider,
        extract(epoch from now() - max(beat_at))::int AS hb_age_s,
        max(beat_at)                                  AS last_beat,
        count(DISTINCT worker_id)::int                AS n_workers
      FROM worker_heartbeat WHERE beat_at > now() - interval '30 min' GROUP BY 1
    ),
    clm AS (
      SELECT worker_provider, count(*)::int AS claimed_5m
      FROM challenge_assignments WHERE claimed_at > now() - interval '5 min' GROUP BY 1
    ),
    smp AS (
      -- 15-min window (was 24h): the matrix only needs the 5-min rate + a recent
      -- "last sample" per cloud. A 24h grouped scan ran 2.5–100s (no standalone
      -- time index); a 15-min partition-pruned slice is fast. Healthy clouds
      -- sample every second so last_sample is always present; a dead cloud
      -- (>15m) shows the ">2h" fallback in the UI.
      SELECT worker_provider,
        count(*) FILTER (WHERE started_at > now() - interval '5 min')::int AS sampled_5m,
        extract(epoch from now() - max(started_at))::int                   AS sample_age_s,
        max(started_at)                                                    AS last_sample
      FROM samples WHERE started_at > now() - interval '15 min' GROUP BY 1
    )
    SELECT c.worker_provider,
      hb.hb_age_s, hb.last_beat, coalesce(hb.n_workers, 0)::int AS n_workers,
      coalesce(clm.claimed_5m, 0)::int            AS claimed_5m,
      coalesce(smp.sampled_5m, 0)::int            AS sampled_5m,
      smp.sample_age_s, smp.last_sample
    FROM clouds c
    LEFT JOIN hb  ON hb.worker_provider  = c.worker_provider
    LEFT JOIN clm ON clm.worker_provider = c.worker_provider
    LEFT JOIN smp ON smp.worker_provider = c.worker_provider
    ORDER BY c.worker_provider
  `)) as unknown as Array<{
    worker_provider: string;
    hb_age_s: number | null;
    last_beat: string | Date | null;
    n_workers: number;
    claimed_5m: number;
    sampled_5m: number;
    sample_age_s: number | null;
    last_sample: string | Date | null;
  }>;

  // The 24h sparkline (fetchTimeline) is NOT fetched here — it's the one
  // unavoidable long scan, so /status renders it behind its own Suspense
  // boundary (StatusTimelineSection) instead of blocking the live funnel +
  // cloud matrix on it.

  // ── Stage states ────────────────────────────────────────────────────────
  const perMin = (n: number) => (n / 5).toFixed(0);

  const genState: StageState =
    f.gen_hb_age_s == null ? "down" : f.gen_hb_age_s > 120 ? "warn" : "ok";
  const dispatchState: StageState = f.dispatched_5m > 0 ? "ok" : "down";
  // The invariant that would have caught the clock-skew outage directly.
  const ttlState: StageState =
    f.ttl_min_s == null
      ? "unknown"
      : f.ttl_min_s <= 0
        ? "down"
        : f.ttl_avg_s != null && f.ttl_avg_s < 10
          ? "warn"
          : "ok";
  const claimState: StageState = f.claimed_5m > 0 ? "ok" : "down";
  const sampleState: StageState = f.sampled_5m > 0 ? "ok" : "down";

  const stages: PipelineStage[] = [
    {
      key: "generator",
      label: "Generator",
      state: genState,
      metric: f.gen_hb_age_s == null ? "no heartbeat" : `heartbeat ${f.gen_hb_age_s}s ago`,
      lastSeenAgeS: f.gen_hb_age_s,
      detail: "Leader is alive and holding the dispatch lock.",
    },
    {
      key: "dispatch",
      label: "Challenges dispatched",
      state: dispatchState,
      metric: `~${perMin(f.dispatched_5m)} / min`,
      lastSeenAgeS: f.dispatch_age_s,
      detail: "New challenges written with assignments fanned out to vantages.",
    },
    {
      key: "ttl",
      label: "Challenge TTL valid",
      state: ttlState,
      metric:
        f.ttl_avg_s == null
          ? "no recent challenges"
          : `avg ${f.ttl_avg_s}s · min ${f.ttl_min_s}s`,
      lastSeenAgeS: null,
      detail:
        ttlState === "down"
          ? "TTL is ≤0: challenges are born expired (generator clock skew). Workers will skip every challenge."
          : "expires_at − generated_at, both DB-clock. Should be ~30s.",
    },
    {
      key: "claim",
      label: "Assignments claimed",
      state: claimState,
      metric: `~${perMin(f.claimed_5m)} / min`,
      lastSeenAgeS: f.claim_age_s,
      detail: "Workers across all clouds are picking up assignments.",
    },
    {
      key: "samples",
      label: "Samples written",
      state: sampleState,
      metric: `~${perMin(f.sampled_5m)} / min`,
      lastSeenAgeS: f.sample_age_s,
      detail: "Benchmark results landing in the samples table, the end of the pipeline.",
    },
  ];

  const clouds: CloudRow[] = cloudRows.map((r) => {
    const state: StageState =
      r.hb_age_s == null
        ? "down"
        : r.sampled_5m > 0
          ? "ok"
          : r.claimed_5m > 0
            ? "warn" // claiming but not producing → the outage signature
            : "down";
    return {
      worker_provider: r.worker_provider,
      label: WORKER_PROVIDER_LABELS[r.worker_provider] ?? r.worker_provider,
      state,
      hbAgeS: r.hb_age_s,
      nWorkers: r.n_workers,
      claimed5m: r.claimed_5m,
      sampled5m: r.sampled_5m,
      sampleAgeS: r.sample_age_s,
      lastBeatIso: r.last_beat == null ? null : new Date(r.last_beat).toISOString(),
      lastSampleIso: r.last_sample == null ? null : new Date(r.last_sample).toISOString(),
    };
  });

  const order: StageState[] = ["down", "warn", "unknown", "ok"];
  const worst = (states: StageState[]) =>
    order.find((o) => states.includes(o)) ?? "ok";
  const overall = worst([...stages.map((s) => s.state), ...clouds.map((c) => c.state)]);

  return {
    overall,
    stages,
    clouds,
    auditorUnavailPct: f.auditor_unavail_pct,
    generatedAtIso: new Date().toISOString(),
  };
}

/**
 * NOT unstable_cache'd. /status is force-dynamic and must reflect LIVE DB state.
 * A 20s data-cache wrapper here previously got stuck serving a >1d-old snapshot
 * while AutoRefresh + LiveAge kept advancing the "N ago" clocks — making a
 * fully-healthy fleet (heartbeats 0–3s old) read as "1d 10h ago · Healthy". The
 * queries are cheap, indexed, recent-slice scans, so each render fetches fresh;
 * AutoRefresh (20s) and LiveAge keep an open tab current.
 */
export const fetchPipelineStatus = fetchPipelineStatusImpl;

/** Humanize an age in seconds → "3h 31m", "45s", "2d 4h". */
export function humanizeAge(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Absolute UTC clock time `age` seconds before `nowIso`. */
export function brokeAtUtc(nowIso: string, ageS: number): string {
  const t = new Date(new Date(nowIso).getTime() - ageS * 1000);
  return t.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
