/**
 * Shared types, formatters, score visualization helpers, and sort comparators
 * for the leaderboard (IndexLeaderboard.tsx) and the provider deep-dive page.
 *
 * No "use client" — these are pure functions and presentational JSX with no
 * hooks, so they can be imported by either client- or server-side code.
 */

import { Fragment } from "react";
import { type GeoRegion } from "@rpcbench/shared/types";
import {
  score,
  type ProviderMetrics,
  type ScoredProvider,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import { explainAntiGamingFlags } from "@/lib/antiGamingFlags";
import { describeFailure } from "@/lib/failureLabels";

// ---------------------------------------------------------------------------
// Row shapes — single source of truth, consumed by both the table and cards.
// ---------------------------------------------------------------------------

/** One failure_category and its count, for the success-% breakdown tooltips. */
export interface FailureBreakdownEntry {
  category: string;
  n: number;
}

export interface SingleLeaderRow {
  provider_id: string;
  provider_name: string;
  caveat_flags: readonly string[];
  caveat_explanation: string;
  // Score sub-components on a 0-100 scale.
  total: number;
  latency_sub: number;
  win_sub: number;
  reliability_sub: number;
  correctness_sub: number;
  freshness_sub: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  stddev_ms: number | null;
  success_rate: number;
  correctness_rate: number;
  completeness_rate: number;
  freshness_p95_lag: number | null;
  n_wins: number;
  n_challenges_with_winner: number;
  win_rate: number;
  sample_count_total: number;
  sample_count_failed: number;
  sample_count_valid: number;
  success_rate_calls: number;
  /** Per-category breakdown of the failed calls (sums to sample_count_failed). */
  failure_breakdown: FailureBreakdownEntry[];
  confidence: "low" | "medium" | "high" | "very-high";
  eligible: boolean;
  failing_reason: string | null;
}

export interface PerGeoScore {
  total: number;
  latency_sub: number;
  win_sub: number;
  reliability_sub: number;
  correctness_sub: number;
  freshness_sub: number;
}

export interface OverallLeaderRow {
  provider_id: string;
  provider_name: string;
  caveat_flags: readonly string[];
  caveat_explanation: string;
  total: number;
  p50_blend: number | null;
  p95_blend: number | null;
  p99_blend: number | null;
  total_wins: number;
  total_calls: number;
  total_failed: number;
  total_challenges_with_winner: number;
  success_rate_calls: number;
  /** Per-category breakdown of total_failed, summed across geos. */
  failure_breakdown: FailureBreakdownEntry[];
  win_rate: number;
  per_geo: Partial<Record<GeoRegion, PerGeoScore | null>>;
}

// ---------------------------------------------------------------------------
// Score text color — tiered green/amber/red.
// ---------------------------------------------------------------------------

/**
 * Solid text color for a 0–100 composite score. ONLY for the composite `total`
 * — not win-rate (exclusive wins rarely clear 60%) or R/C/Cm rates (cluster at
 * 97–100%); tiering those would mislead. See plan §3.
 */
export function scoreColor(score: number): string {
  if (score >= 80) return "#7be0a4"; // good · green
  if (score >= 60) return "#f3c27a"; // warn · amber
  return "#f08080"; // bad · red
}

// ---------------------------------------------------------------------------
// Score breakdown JSX (shared by tooltip and bottom sheet)
// ---------------------------------------------------------------------------

// `tracking-normal leading-normal normal-case` resets any display-font
// typography inherited from the trigger's context (e.g. the leaderboard row's
// 44px / -0.03em / line-height:1) so the breakdown text stays legible.
const BREAKDOWN_RESET = "tracking-normal leading-normal normal-case";

export function ScoreFormula({ weights }: { weights: ScoringWeights }) {
  return (
    <div className={`font-mono text-[11px] text-neutral-200 ${BREAKDOWN_RESET}`}>
      Score = {weights.latency}·L + {weights.winRate}·W + {weights.reliability}·R +{" "}
      {weights.correctness}·C + {weights.freshness}·F
    </div>
  );
}

export function SubScoreBreakdown({
  row,
  weights,
}: {
  row: {
    latency_sub: number;
    win_sub: number;
    reliability_sub: number;
    correctness_sub: number;
    freshness_sub: number;
    total: number;
  };
  weights: ScoringWeights;
}) {
  const parts: Array<{ k: string; label: string; sub: number; w: number; color: string }> = [
    { k: "L", label: "Latency", sub: row.latency_sub, w: weights.latency, color: "#7cc6ff" },
    { k: "W", label: "Win rate", sub: row.win_sub, w: weights.winRate, color: "#f59ec3" },
    { k: "R", label: "Reliability", sub: row.reliability_sub, w: weights.reliability, color: "#a78bfa" },
    { k: "C", label: "Correctness", sub: row.correctness_sub, w: weights.correctness, color: "#7be0a4" },
    { k: "F", label: "Freshness", sub: row.freshness_sub, w: weights.freshness, color: "#f3c27a" },
  ];
  // CSS Grid keeps numeric columns in perfect vertical alignment across rows.
  // Columns: key · label · sub · × · weight · = · product
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "14px 84px 48px auto 36px auto 52px",
    columnGap: 8,
    rowGap: 2,
    alignItems: "baseline",
  };
  return (
    <div
      className={`font-mono text-[11px] text-neutral-300 mt-1.5 tabular-nums ${BREAKDOWN_RESET}`}
      style={gridStyle}
    >
      {parts.map((p) => (
        <Fragment key={p.k}>
          <span style={{ color: p.color }}>{p.k}</span>
          <span className="text-neutral-400">({p.label})</span>
          <span style={{ textAlign: "right" }}>{p.sub.toFixed(1)}</span>
          <span className="text-neutral-500">×</span>
          <span style={{ textAlign: "right" }}>{p.w.toFixed(2)}</span>
          <span className="text-neutral-500">=</span>
          <span style={{ textAlign: "right" }}>{(p.sub * p.w).toFixed(2)}</span>
        </Fragment>
      ))}
      {/* Full-width separator — single cell spanning all columns so the line
          doesn't get broken by the grid's column gaps. */}
      <span
        style={{
          gridColumn: "1 / -1",
          borderTop: "1px solid #404040",
          marginTop: 4,
        }}
      />
      {/* Total row — placeholder cells for cols 1-5, then "=" and the total
          aligned with the product column. */}
      <span style={{ gridColumn: "1 / span 5" }} />
      <span className="text-neutral-400">=</span>
      <span className="text-neutral-100" style={{ textAlign: "right" }}>
        {row.total.toFixed(1)}
      </span>
    </div>
  );
}

/**
 * Overall-score breakdown: how the per-region scores blend into one number.
 * `overall = Σ (region_score × normalized_region_weight)`. Weights are the
 * region weights renormalized over the regions where the provider is eligible
 * (so they sum to 1) — matching blendRegionScores().
 */
export function RegionBlendBreakdown({
  regions,
  total,
}: {
  regions: ReadonlyArray<{ label: string; weight: number; score: number }>;
  total: number;
}) {
  // Columns: region · score · × · weight · = · product
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "auto 48px auto 44px auto 52px",
    columnGap: 8,
    rowGap: 2,
    alignItems: "baseline",
  };
  return (
    <div
      className={`font-mono text-[11px] text-neutral-300 mt-1.5 tabular-nums ${BREAKDOWN_RESET}`}
      style={gridStyle}
    >
      {regions.map((r) => (
        <Fragment key={r.label}>
          <span className="text-neutral-400">{r.label}</span>
          <span style={{ textAlign: "right" }}>{r.score.toFixed(1)}</span>
          <span className="text-neutral-500">×</span>
          <span style={{ textAlign: "right" }}>{r.weight.toFixed(2)}</span>
          <span className="text-neutral-500">=</span>
          <span style={{ textAlign: "right" }}>{(r.score * r.weight).toFixed(2)}</span>
        </Fragment>
      ))}
      <span style={{ gridColumn: "1 / -1", borderTop: "1px solid #404040", marginTop: 4 }} />
      <span style={{ gridColumn: "1 / span 4" }} />
      <span className="text-neutral-400">=</span>
      <span className="text-neutral-100" style={{ textAlign: "right" }}>
        {total.toFixed(1)}
      </span>
    </div>
  );
}

/**
 * Why a provider's success % is below 100: the failed calls grouped by failure
 * category (counts reconcile with sample_count_failed, so they sum to the
 * missing %). Rendered inside the success-% tooltips on the leaderboard and the
 * provider hero. Category-level only — the precompute stores failure_category,
 * not failure_detail (the provider page's Section 05 table has both).
 */
export function FailureBreakdownList({
  breakdown,
  totalFailed,
}: {
  breakdown: FailureBreakdownEntry[];
  totalFailed: number;
}) {
  if (totalFailed <= 0 || breakdown.length === 0) {
    return (
      <div className={`text-[11px] text-neutral-400 ${BREAKDOWN_RESET}`}>
        No failed calls in this window.
      </div>
    );
  }
  const sorted = [...breakdown].sort((a, b) => b.n - a.n);
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    columnGap: 10,
    rowGap: 3,
    alignItems: "baseline",
  };
  return (
    <div className={`${BREAKDOWN_RESET}`}>
      <div className="font-mono text-[11px] text-neutral-400 mb-1">
        {totalFailed.toLocaleString()} failed
      </div>
      <div className="text-[11px] text-neutral-300 tabular-nums" style={gridStyle}>
        {sorted.map((f) => {
          const d = describeFailure(f.category, null);
          const pct = (f.n / totalFailed) * 100;
          return (
            <Fragment key={f.category}>
              <span className="text-neutral-200" title={d.hint}>
                {d.label}
                <code className="text-neutral-500 ml-1.5 text-[10px]">{f.category}</code>
              </span>
              <span style={{ textAlign: "right" }}>{f.n.toLocaleString()}</span>
              <span className="text-neutral-500" style={{ textAlign: "right" }}>
                {pct.toFixed(0)}%
              </span>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw aggregate row from the server query + helpers to turn it into rows the
// leaderboard renders. Moved out of page.tsx 2026-05-26 so the client-side
// IndexLeaderboard can rebuild rows as weights change (no server round-trip
// per slider tick).
// ---------------------------------------------------------------------------

export interface RowAgg {
  provider_id: string;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  stddev_ms: number | null;
  sample_count_valid: number;
  sample_count_total: number;
  sample_count_failed: number;
  success_rate: number | null;
  correctness_rate: number | null;
  completeness_rate: number | null;
  freshness_p95_lag: number | null;
  honeypot_pass_count: number;
  honeypot_total: number;
  n_wins: number;
  n_challenges_with_winner: number;
  /** Per-category failed-call counts (jsonb from the failures companion). */
  failure_breakdown: FailureBreakdownEntry[];
  eligible: boolean | null;
  failing_reason: string | null;
}

export interface PerGeoOutcome {
  geo: GeoRegion;
  rows: RowAgg[];
  eligible: RowAgg[];
  scored: ScoredProvider[];
}

export function confidenceBadge(n: number): SingleLeaderRow["confidence"] {
  if (n >= 100_000) return "very-high";
  if (n >= 10_000) return "high";
  if (n >= 1000) return "medium";
  return "low";
}

export function rowToMetrics(r: RowAgg): ProviderMetrics {
  return {
    provider_id: r.provider_id,
    p50_latency_ms: r.p50_ms ?? Number.POSITIVE_INFINITY,
    p95_latency_ms: r.p95_ms ?? Number.POSITIVE_INFINITY,
    success_rate: r.success_rate ?? 0,
    correct_count: Math.round(
      (r.correctness_rate ?? 0) * (r.sample_count_valid ?? 0),
    ),
    validated_count: r.sample_count_valid ?? 0,
    freshness_p95_lag: r.freshness_p95_lag ?? 1,
    n_wins: r.n_wins ?? 0,
    n_challenges_with_winner: r.n_challenges_with_winner ?? 0,
  };
}

/** Score all eligible rows in `outcome.eligible` against `weights`. */
export function scorePerGeo(
  outcome: { eligible: RowAgg[] },
  weights: ScoringWeights,
): ScoredProvider[] {
  return score(outcome.eligible.map(rowToMetrics), weights);
}

/**
 * One full row per benchmarked provider — always. Providers that haven't met
 * the eligibility floor get a 0 score (and 0 sub-scores) but still show every
 * column populated from whatever raw metrics they do have (— for genuinely
 * missing values). No separate "below thresholds" treatment, no empty state.
 * Iterates BENCHMARKED_PROVIDERS (code) so a stale DB row can't resurrect a
 * retired provider.
 */
export function buildSingleLeaderRows(outcome: PerGeoOutcome): {
  rows: SingleLeaderRow[];
  ineligible: SingleLeaderRow[];
} {
  const scoredById = new Map(outcome.scored.map((s) => [s.provider_id, s]));
  const metaById = new Map(outcome.rows.map((r) => [r.provider_id, r]));

  const rows: SingleLeaderRow[] = BENCHMARKED_PROVIDERS.map((provider) => {
    const meta = metaById.get(provider.id);
    const s = scoredById.get(provider.id);
    const flags = provider.anti_gaming_flags ?? [];
    const winDenom = meta?.n_challenges_with_winner ?? 0;
    const winRate = winDenom > 0 ? (meta?.n_wins ?? 0) / winDenom : 0;
    const total = meta?.sample_count_total ?? 0;
    const failed = meta?.sample_count_failed ?? 0;
    const successRate = total > 0 ? 1 - failed / total : 0;
    return {
      provider_id: provider.id,
      provider_name: provider.name,
      caveat_flags: flags,
      caveat_explanation: flags.length > 0 ? explainAntiGamingFlags(flags) : "",
      total: s?.total ?? 0,
      latency_sub: s?.latency ?? 0,
      win_sub: s?.winRate ?? 0,
      reliability_sub: s?.reliability ?? 0,
      correctness_sub: s?.correctness ?? 0,
      freshness_sub: s?.freshness ?? 0,
      p50_ms: meta?.p50_ms ?? null,
      p95_ms: meta?.p95_ms ?? null,
      p99_ms: meta?.p99_ms ?? null,
      stddev_ms: meta?.stddev_ms ?? null,
      success_rate: meta?.success_rate ?? 0,
      correctness_rate: meta?.correctness_rate ?? 0,
      completeness_rate: meta?.completeness_rate ?? 0,
      freshness_p95_lag: meta?.freshness_p95_lag ?? null,
      n_wins: meta?.n_wins ?? 0,
      n_challenges_with_winner: winDenom,
      win_rate: winRate,
      sample_count_total: total,
      sample_count_failed: failed,
      sample_count_valid: meta?.sample_count_valid ?? 0,
      success_rate_calls: successRate,
      failure_breakdown: meta?.failure_breakdown ?? [],
      confidence: confidenceBadge(meta?.sample_count_valid ?? 0),
      eligible: s != null,
      failing_reason: s != null ? null : (meta?.failing_reason ?? null),
    };
  });

  // Default ordering: eligible (scored) first by score desc; unscored fall to
  // the bottom. The table's column-header sort overrides this.
  rows.sort((a, b) => b.total - a.total);

  return { rows, ineligible: [] };
}

/**
 * One full row per benchmarked provider — always. A provider eligible in no
 * region gets overall score 0 but still shows its per-geo cells and call
 * totals. Iterates BENCHMARKED_PROVIDERS (code) so the row set is exactly the
 * current providers regardless of stale DB rows or which ones cleared the
 * floor.
 */
export function buildOverallLeaderRows(
  blended: ScoredProvider[],
  perGeo: PerGeoOutcome[],
): OverallLeaderRow[] {
  const totalChallengesWithWinner = perGeo.reduce((sum, o) => {
    const r = o.rows[0];
    return sum + (r?.n_challenges_with_winner ?? 0);
  }, 0);
  const blendedById = new Map(blended.map((s) => [s.provider_id, s]));

  return BENCHMARKED_PROVIDERS.map((provider) => {
    const s = blendedById.get(provider.id);
    const flags = provider.anti_gaming_flags ?? [];
    let totalWins = 0;
    let totalCalls = 0;
    let totalFailed = 0;
    let wSum = 0;
    let wP50 = 0;
    let wP95 = 0;
    let wP99 = 0;
    const failByCat = new Map<string, number>();
    const per_geo: OverallLeaderRow["per_geo"] = {};
    for (const o of perGeo) {
      const sp = o.scored.find((x) => x.provider_id === provider.id);
      per_geo[o.geo] = sp
        ? {
            total: sp.total,
            latency_sub: sp.latency,
            win_sub: sp.winRate,
            reliability_sub: sp.reliability,
            correctness_sub: sp.correctness,
            freshness_sub: sp.freshness,
          }
        : null;
      const r = o.rows.find((x) => x.provider_id === provider.id);
      if (!r) continue;
      totalWins += r.n_wins ?? 0;
      totalCalls += r.sample_count_total ?? 0;
      totalFailed += r.sample_count_failed ?? 0;
      for (const f of r.failure_breakdown ?? []) {
        failByCat.set(f.category, (failByCat.get(f.category) ?? 0) + f.n);
      }
      const w = r.sample_count_valid ?? 0;
      if (w > 0 && r.p50_ms != null && r.p95_ms != null) {
        wSum += w;
        wP50 += r.p50_ms * w;
        wP95 += r.p95_ms * w;
        wP99 += (r.p99_ms ?? r.p95_ms) * w;
      }
    }
    return {
      provider_id: provider.id,
      provider_name: provider.name,
      caveat_flags: flags,
      caveat_explanation: flags.length > 0 ? explainAntiGamingFlags(flags) : "",
      total: s?.total ?? 0,
      p50_blend: wSum > 0 ? wP50 / wSum : null,
      p95_blend: wSum > 0 ? wP95 / wSum : null,
      p99_blend: wSum > 0 ? wP99 / wSum : null,
      total_wins: totalWins,
      total_calls: totalCalls,
      total_failed: totalFailed,
      total_challenges_with_winner: totalChallengesWithWinner,
      win_rate: totalChallengesWithWinner > 0 ? totalWins / totalChallengesWithWinner : 0,
      success_rate_calls: totalCalls > 0 ? 1 - totalFailed / totalCalls : 0,
      failure_breakdown: [...failByCat.entries()]
        .map(([category, n]) => ({ category, n }))
        .sort((a, b) => b.n - a.n),
      per_geo,
    };
  }).sort((a, b) => b.total - a.total);
}
