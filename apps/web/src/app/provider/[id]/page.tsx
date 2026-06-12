import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  GEO_REGIONS,
  GEO_REGION_LABELS,
  METHODOLOGY_VERSION,
  POOLED_INFRA,
  benchmarkedProviderByRouteParam,
  cloudRegionsForGeo,
  providerSlug,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { DEFAULT_WEIGHTS } from "@rpcbench/shared/scoring";
import { db } from "@/lib/db";
import { fetchLatencySeries } from "@/lib/chartData";
import { fetchRankedOverall } from "@/lib/leaderboard";
import {
  FailureBreakdownList,
  ScoreFormula,
  SubScoreBreakdown,
  type OverallLeaderRow,
  type PerGeoScore,
} from "@/components/leaderboardShared";
import { LatencyChart } from "@/components/LatencyChart";
import { Tooltip } from "@/components/Tooltip";
import { explainAntiGamingFlags } from "@/lib/antiGamingFlags";
import { describeFailure } from "@/lib/failureLabels";

export const dynamic = "force-dynamic";

interface MethodRow {
  method: string;
  bucket: string;
  p50_cold: number | null;
  p95_cold: number | null;
  p99_cold: number | null;
  p50_warm: number | null;
  p95_warm: number | null;
  p99_warm: number | null;
  sample_count_valid: number;
  correctness_rate: number | null;
  completeness_rate: number | null;
  honeypot_total: number;
  honeypot_pass_count: number;
}

interface FailureBreakdownRow {
  failure_category: string;
  failure_detail: string | null;
  n: number;
}

// Per-provider raw-samples aggregates are expensive (exact percentile_cont over
// the last 24h) and this route is force-dynamic, so without a cache they re-run
// on every load. A short TTL (matching the leaderboard/chart caches) keeps the
// page snappy while staying near-live; unstable_cache keys on the providerId arg.
const PROVIDER_CACHE_TTL_S = 30;

const fetchFailureBreakdown = unstable_cache(
  fetchFailureBreakdownImpl,
  ["provider-failure-breakdown"],
  { revalidate: PROVIDER_CACHE_TTL_S },
);

async function fetchFailureBreakdownImpl(providerId: string): Promise<FailureBreakdownRow[]> {
  // Read the pre-aggregated leaderboard_failures_1h rollup rather than scanning
  // raw `samples` (which has no provider+time index, so it scanned the provider's
  // whole failure history — ~13s on a failure-heavy provider). The rollup is tiny
  // and carries per-category counts; it does NOT preserve failure_detail, so the
  // breakdown is category-level (detail renders as "—").
  //
  // Filter to the pooled-infra sentinel (worker_provider='__all__'); the table
  // also stores per-concrete-infra rows, so summing without this would multiply-
  // count the same failures across vantages.
  const rows = await db().execute(sql`
    SELECT failure_category, NULL::text AS failure_detail, sum(n)::int AS n
    FROM leaderboard_failures_1h
    WHERE provider_id = ${providerId}
      AND worker_provider = ${POOLED_INFRA}
      AND methodology_version = ${METHODOLOGY_VERSION}
      AND window_start > now() - interval '24 hours'
    GROUP BY failure_category
    ORDER BY n DESC
    LIMIT 20
  `);
  return rows as unknown as FailureBreakdownRow[];
}

const fetchMethodBreakdown = unstable_cache(
  fetchMethodBreakdownImpl,
  ["provider-method-breakdown"],
  { revalidate: PROVIDER_CACHE_TTL_S },
);

async function fetchMethodBreakdownImpl(providerId: string): Promise<MethodRow[]> {
  // Read from the pre-aggregated hourly rollups (rollups_1h) rather than scanning
  // raw `samples`. The old exact-percentile query over raw samples could only seek
  // on provider_id (started_at is not a leading index column), so it scanned the
  // provider's ENTIRE sample history to keep the last 24h — ~20s on a busy
  // provider. rollups_1h is provider_id-keyed and tiny (≈methods×regions×buckets×
  // modes×24 rows), so this is the same source the home/chart pages use.
  //
  // Percentiles can't be recombined exactly across rollup windows, so we take a
  // sample-weighted mean of each window's p50/p95/p99 — consistent with the
  // sample-weighted aggregation `p50ByMethod` already applies across buckets.
  const rows = await db().execute(sql`
    SELECT
      method, bucket,
      (sum(latency_p50 * sample_count_valid) FILTER (WHERE connection_mode='cold' AND latency_p50 IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='cold' AND latency_p50 IS NOT NULL), 0))::int AS p50_cold,
      (sum(latency_p95 * sample_count_valid) FILTER (WHERE connection_mode='cold' AND latency_p95 IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='cold' AND latency_p95 IS NOT NULL), 0))::int AS p95_cold,
      (sum(latency_p99 * sample_count_valid) FILTER (WHERE connection_mode='cold' AND latency_p99 IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='cold' AND latency_p99 IS NOT NULL), 0))::int AS p99_cold,
      (sum(latency_p50 * sample_count_valid) FILTER (WHERE connection_mode='warm' AND latency_p50 IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='warm' AND latency_p50 IS NOT NULL), 0))::int AS p50_warm,
      (sum(latency_p95 * sample_count_valid) FILTER (WHERE connection_mode='warm' AND latency_p95 IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='warm' AND latency_p95 IS NOT NULL), 0))::int AS p95_warm,
      (sum(latency_p99 * sample_count_valid) FILTER (WHERE connection_mode='warm' AND latency_p99 IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='warm' AND latency_p99 IS NOT NULL), 0))::int AS p99_warm,
      sum(sample_count_valid) FILTER (WHERE connection_mode='cold')::int AS sample_count_valid,
      (sum(correctness_rate * sample_count_valid) FILTER (WHERE connection_mode='cold' AND correctness_rate IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='cold' AND correctness_rate IS NOT NULL), 0))::real AS correctness_rate,
      (sum(completeness_rate * sample_count_valid) FILTER (WHERE connection_mode='cold' AND completeness_rate IS NOT NULL)
       / NULLIF(sum(sample_count_valid) FILTER (WHERE connection_mode='cold' AND completeness_rate IS NOT NULL), 0))::real AS completeness_rate,
      sum(honeypot_total) FILTER (WHERE connection_mode='cold')::int        AS honeypot_total,
      sum(honeypot_pass_count) FILTER (WHERE connection_mode='cold')::int   AS honeypot_pass_count
    FROM rollups_1h
    WHERE provider_id = ${providerId}
      AND methodology_version = ${METHODOLOGY_VERSION}
      AND window_start > now() - interval '24 hours'
    GROUP BY method, bucket
    ORDER BY method, bucket
  `);
  return rows as unknown as MethodRow[];
}

/** Sample-weighted p50 (cold) per method, across difficulty buckets. */
function p50ByMethod(breakdown: MethodRow[]): Array<{ method: string; value: number }> {
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of breakdown) {
    if (r.p50_cold == null || r.sample_count_valid <= 0) continue;
    const a = agg.get(r.method) ?? { sum: 0, n: 0 };
    a.sum += r.p50_cold * r.sample_count_valid;
    a.n += r.sample_count_valid;
    agg.set(r.method, a);
  }
  return [...agg.entries()]
    .filter(([, a]) => a.n > 0)
    .map(([method, a]) => ({ method, value: a.sum / a.n }))
    .sort((x, y) => x.value - y.value);
}

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  // The [id] segment is a route slug (e.g. "helius"), which may differ from the
  // provider_id (e.g. "helius_gatekeeper", a frozen DB foreign key). Resolve by
  // slug-or-id, then canonicalize to the slug URL so the id form redirects.
  const { id: routeParam } = await params;
  const provider = benchmarkedProviderByRouteParam(routeParam);
  if (!provider) notFound();
  if (routeParam !== providerSlug(provider)) redirect(`/provider/${providerSlug(provider)}`);
  // Real provider_id for every DB query / rank lookup below.
  const id = provider.id;

  const allMethods: Method[] = ["getBlock", "getTransaction", "getSignaturesForAddress"];

  let breakdown: MethodRow[] = [];
  let failures: FailureBreakdownRow[] = [];
  let chartSeries: Awaited<ReturnType<typeof fetchLatencySeries>> = [];
  let ranked: OverallLeaderRow[] = [];
  let error: string | null = null;
  try {
    [breakdown, failures, chartSeries, ranked] = await Promise.all([
      fetchMethodBreakdown(id),
      fetchFailureBreakdown(id),
      fetchLatencySeries({
        // Provider detail chart pools every active geo (all 6 GEO_REGIONS).
        cloudPairs: GEO_REGIONS.flatMap((g) => cloudRegionsForGeo(g)),
        methods: allMethods,
        windowHours: 24,
        provider_id: id,
      }),
      fetchRankedOverall(),
    ]);
  } catch (err) {
    error = (err as Error).message;
  }

  // Resolve this provider's rank + composite score from the same Overall blend
  // the home leaderboard renders, so the numbers agree across pages.
  const rankIdx = ranked.findIndex((r) => r.provider_id === id);
  const row = rankIdx >= 0 ? ranked[rankIdx]! : null;
  const isRanked = ranked.some((r) => r.total > 0);
  const rank = rankIdx >= 0 ? rankIdx + 1 : ranked.length + 1;
  const isLeader = rank === 1;
  const leader = ranked[0] ?? null;
  const scoreGap = row && leader ? leader.total - row.total : 0;

  // Composite score per geo for this provider, from the same Overall blend the
  // leaderboard uses (per_geo carries each region's score). null = the provider
  // didn't clear the eligibility floor in that region.
  const regionScores: Array<{
    geo: GeoRegion;
    label: string;
    score: number | null;
    sub: PerGeoScore | null;
  }> = row
    ? GEO_REGIONS.filter((g) => g in row.per_geo).map((g) => ({
        geo: g,
        label: GEO_REGION_LABELS[g],
        score: row.per_geo[g]?.total ?? null,
        sub: row.per_geo[g] ?? null,
      }))
    : [];
  regionScores.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const regionScoreVals = regionScores
    .map((r) => r.score)
    .filter((s): s is number => s != null);
  const bestRegionScore = regionScoreVals.length > 0 ? Math.max(...regionScoreVals) : 0;
  const worstRegionScore = regionScoreVals.length > 0 ? Math.min(...regionScoreVals) : 0;

  const methodRows = p50ByMethod(breakdown);
  const methodMin = methodRows.length > 0 ? Math.min(...methodRows.map((m) => m.value)) : 0;
  const methodMax = methodRows.length > 0 ? Math.max(...methodRows.map((m) => m.value)) : 0;
  const failTotal = totalOf(failures);

  return (
    <section className="lb-index prov-page">
      <Link href="/" className="prov-back">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M19 12H5M11 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Leaderboard
      </Link>

      <div className="idx-head prov-head">
        <span className="section-kicker">01 · Provider · live</span>
      </div>

      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, margin: "8px 0 16px" }}>
          DB error: {error}
        </div>
      )}

      {/* Hero — rank · name · score in big type, with the live stat strip. */}
      <div className="idx-row-prov">
        <span className="idx-rank">{String(rank).padStart(2, "0")}</span>
        <span className="idx-name">{provider.name}</span>
        <span className="idx-score">{row && isRanked ? row.total.toFixed(1) : "—"}</span>
      </div>
      <div className="prov-stat-strip">
        <div className="idx-stat">
          <span className="idx-stat-l">p50 latency</span>
          <span className="idx-stat-v">{fmtMs(row?.p50_blend)}</span>
        </div>
        <div className="idx-stat">
          <span className="idx-stat-l">p95 latency</span>
          <span className="idx-stat-v">{fmtMs(row?.p95_blend)}</span>
        </div>
        <div className="idx-stat">
          <span className="idx-stat-l">p99 latency</span>
          <span className="idx-stat-v">{fmtMs(row?.p99_blend)}</span>
        </div>
        <div className="idx-stat">
          <span className="idx-stat-l">win rate</span>
          <span className="idx-stat-v">{((row?.win_rate ?? 0) * 100).toFixed(0)}<i>%</i></span>
        </div>
        <div className="idx-stat">
          <span className="idx-stat-l">samples</span>
          <span className="idx-stat-v">{(row?.total_calls ?? 0).toLocaleString()}</span>
        </div>
        <div className="idx-stat">
          <span className="idx-stat-l">success</span>
          {(row?.total_failed ?? 0) > 0 ? (
            <Tooltip
              align="right"
              title="Failure breakdown"
              trigger={
                <span className="idx-stat-v" style={{ cursor: "help" }}>
                  {((row?.success_rate_calls ?? 0) * 100).toFixed(1)}<i>%</i>
                </span>
              }
            >
              <div className="text-left font-normal normal-case tracking-normal leading-normal">
                <FailureBreakdownList
                  breakdown={row?.failure_breakdown ?? []}
                  totalFailed={row?.total_failed ?? 0}
                />
              </div>
            </Tooltip>
          ) : (
            <span className="idx-stat-v">{((row?.success_rate_calls ?? 0) * 100).toFixed(1)}<i>%</i></span>
          )}
        </div>
      </div>

      {isRanked && !isLeader && leader && (
        <div className="prov-context">
          <span className="prov-context-label">Behind leader</span>
          <span className="prov-context-name">{leader.provider_name}</span>
          <span className="prov-context-gap">−{scoreGap.toFixed(1)} score</span>
        </div>
      )}

      {provider.anti_gaming_flags.length > 0 && (
        <div className="prov-caveat">
          <span
            className="badge warn"
            style={{ cursor: "help" }}
            title={explainAntiGamingFlags(provider.anti_gaming_flags)}
          >
            anti-gaming caveats: {provider.anti_gaming_flags.join(", ")}
          </span>
        </div>
      )}

      {/* 02 — Latency over time */}
      <div className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">02 · Latency over time · 24h</span>
          <span className="prov-section-count">cold · all regions</span>
        </div>
        <div style={{ marginTop: 14 }}>
          <LatencyChart series={chartSeries} windowHours={24} connectionMode="cold" />
        </div>
      </div>

      {/* 03 — Score by region */}
      <div className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">03 · Score by region</span>
          <span className="prov-section-count">higher is better</span>
        </div>
        {regionScores.length === 0 ? (
          <p className="prov-empty">No regional scores yet; collecting samples.</p>
        ) : (
          <ul className="prov-list">
            {regionScores.map((r) => {
              const isBest = r.score != null && r.score === bestRegionScore && bestRegionScore > 0;
              const isWorst =
                r.score != null && r.score === worstRegionScore && bestRegionScore > worstRegionScore;
              // Higher score = longer bar. Min-max normalized to a 30–100% span
              // so regional differences read at a glance (mirrors Latency by method).
              const range = Math.max(0.01, bestRegionScore - worstRegionScore);
              const pct = r.score != null ? 30 + ((r.score - worstRegionScore) / range) * 70 : 0;
              return (
                <li
                  key={r.geo}
                  className={
                    "prov-row group relative" +
                    (isBest ? " is-best" : "") +
                    (isWorst ? " is-worst" : "")
                  }
                >
                  <span className="prov-row-name">{r.label}</span>
                  <span className="prov-row-bar">
                    <span className="prov-row-bar-fill" style={{ width: Math.max(8, pct) + "%" }} />
                  </span>
                  <span className="prov-row-val">{r.score != null ? r.score.toFixed(1) : "—"}</span>
                  {/* Hover breakdown: how this region's composite score is built
                      from the L/W/R/C/F sub-scores × weights. Absolutely
                      positioned so it doesn't occupy a grid column; CSS-gated to
                      hover-capable devices via .tooltip-hover-popup. */}
                  {r.sub && (
                    <span
                      role="tooltip"
                      className="tooltip-hover-popup absolute top-full right-0 mt-1 z-50 min-w-[280px] max-w-[420px] rounded-md border border-neutral-700 bg-neutral-950/95 backdrop-blur px-3 py-2 text-xs text-neutral-200 font-normal shadow-xl shadow-black/60 pointer-events-none normal-case tracking-normal leading-normal"
                    >
                      <div className="font-mono text-[11px] text-neutral-400 mb-0.5">
                        {r.label} score
                      </div>
                      <ScoreFormula weights={DEFAULT_WEIGHTS} />
                      <SubScoreBreakdown row={r.sub} weights={DEFAULT_WEIGHTS} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 04 — Latency by method */}
      <div className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">04 · Latency by method · p50 cold</span>
          <span className="prov-section-count">{methodRows.length}</span>
        </div>
        {methodRows.length === 0 ? (
          <p className="prov-empty">No samples in the last 24h.</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <ul className="prov-list">
              {methodRows.map((m) => {
                const isBest = m.value === methodMin;
                const isWorst = methodRows.length > 1 && m.value === methodMax;
                const range = Math.max(0.01, methodMax - methodMin);
                // Lower latency = best → longer bar. Invert.
                const pct = 100 - ((m.value - methodMin) / range) * 70;
                return (
                  <li key={m.method} className={"prov-row" + (isBest ? " is-best" : "") + (isWorst ? " is-worst" : "")}>
                    <span className="prov-row-name"><code>{m.method}</code></span>
                    <span className="prov-row-bar">
                      <span className="prov-row-bar-fill" style={{ width: Math.max(8, pct) + "%" }} />
                    </span>
                    <span className="prov-row-val">{m.value.toFixed(0)}<i>ms</i></span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* 04 — Failure breakdown */}
      <div className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">05 · Failure breakdown · 24h</span>
          <span className="prov-section-count">{failures.length}</span>
        </div>
        {failures.length === 0 ? (
          <p className="prov-empty">
            No failed samples in the last 24h. Every call matched the quorum reference.
          </p>
        ) : (
          <div className="prov-table-wrap is-scroll">
            <table className="prov-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Detail</th>
                  <th className="prov-num">Share</th>
                  <th className="prov-num">Count</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => {
                  const d = describeFailure(f.failure_category, f.failure_detail);
                  return (
                    <tr key={`${f.failure_category}-${f.failure_detail ?? ""}`} title={d.hint}>
                      <td>
                        {d.label}
                        <code className="prov-ch-method" style={{ marginLeft: 8, opacity: 0.55 }}>
                          {f.failure_category}
                        </code>
                      </td>
                      <td>{f.failure_detail ?? "—"}</td>
                      <td className="prov-num">
                        {failTotal > 0 ? ((f.n / failTotal) * 100).toFixed(0) : "0"}%
                      </td>
                      <td className="prov-num">{f.n.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function totalOf(failures: FailureBreakdownRow[]): number {
  return failures.reduce((s, f) => s + f.n, 0);
}

function fmtMs(v: number | null | undefined): React.ReactNode {
  return v == null ? "—" : <>{Math.round(v)}<i>ms</i></>;
}
