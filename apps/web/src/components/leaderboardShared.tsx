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
  blendRegionScores,
  blendMethodScores,
  DEFAULT_WEIGHTS,
  DEFAULT_REGION_WEIGHTS,
  MIN_METHOD_COVERAGE,
  type MethodWeights,
  type ProviderMetrics,
  type RegionWeights,
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

/**
 * A leaderboard row under a workload preset: the score is blended across the
 * preset's METHODS (and regions), so there is no single meaningful latency
 * percentile (a p50 averaged across getSlot and getProgramAccounts is
 * nonsense). The row therefore drops p50/p95/p99 and instead carries:
 *   - the blended composite `total` + the five normalized 0–100 sub-scores,
 *   - sum/ratio aggregates that DO blend meaningfully across the workload
 *     (win rate, calls, failures, success rate, failure breakdown),
 *   - `coverage` (fraction of method weight the provider is eligible for) and
 *     whether it cleared the gate,
 *   - `per_geo` composite preset scores, and a `per_method` drill-down where
 *     each method's REAL p50/p95 lives.
 */
export interface PresetLeaderRow {
  provider_id: string;
  provider_name: string;
  caveat_flags: readonly string[];
  caveat_explanation: string;
  total: number;
  latency_sub: number;
  win_sub: number;
  reliability_sub: number;
  correctness_sub: number;
  freshness_sub: number;
  coverage_pct: number;
  coverage_ok: boolean;
  exclusion_reason: string | null;
  // Sum/ratio aggregates across the preset's (method, geo) cells — meaningful
  // (NOT percentiles).
  total_wins: number;
  total_calls: number;
  total_failed: number;
  total_challenges_with_winner: number;
  success_rate_calls: number;
  win_rate: number;
  failure_breakdown: FailureBreakdownEntry[];
  /** Per-geo COMPOSITE preset score (method-blend within the geo). */
  per_geo: Partial<Record<GeoRegion, PerGeoScore | null>>;
  /** Per-method blended-region score + that method's real p50/p95. */
  per_method: Record<string, { total: number; p50: number | null; p95: number | null } | null>;
}

/** Per-(method, geo) rows for the preset blend: `rows` (all providers, for
 *  aggregates) + `eligible` (scored subset). The flat shape both the client
 *  memo and the server `fetchRankedPreset` produce. */
export interface MethodGeoRows {
  method: string;
  geo: GeoRegion;
  rows: RowAgg[];
  eligible: RowAgg[];
}

// ---------------------------------------------------------------------------
// Score text color — tiered green/amber/red.
// ---------------------------------------------------------------------------

/**
 * Solid text color for a 0–100 composite score. ONLY for the composite `total`
 * — not win-rate (exclusive wins rarely clear 60%) or R/C/Cm rates (cluster at
 * 97–100%); tiering those would mislead.
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

/**
 * Build leaderboard rows under a workload preset — the score blended across the
 * preset's methods AND regions. Single source of truth for the Overview board,
 * the hero logo, the provider deep-dive, and the public API (the client memo
 * and the server `fetchRankedPreset` both call this over the same cube).
 *
 * Pipeline: score per (method, geo) → blendRegionScores({subs:true}) per method
 * → blendMethodScores (coverage gate) for the overall ranking; a second
 * blendMethodScores per geo (no gate) for the per-geo composite cells. Sum/ratio
 * aggregates (wins, calls, failures) sum across every (method, geo) cell; the
 * meaningless cross-method latency percentiles are NOT produced.
 */
export function buildPresetLeaderRows(
  cube: MethodGeoRows[],
  opts: {
    componentWeights: ScoringWeights;
    methodWeights: MethodWeights;
    regionWeights: Partial<RegionWeights>;
    minCoverage?: number;
  },
): PresetLeaderRow[] {
  const { componentWeights, methodWeights, regionWeights } = opts;
  const minCoverage = opts.minCoverage ?? MIN_METHOD_COVERAGE;

  // method -> (geo -> scored eligible providers), used for both blends.
  const scoredByMethodGeo = new Map<string, Map<GeoRegion, ScoredProvider[]>>();
  for (const cell of cube) {
    let geoMap = scoredByMethodGeo.get(cell.method);
    if (!geoMap) {
      geoMap = new Map();
      scoredByMethodGeo.set(cell.method, geoMap);
    }
    geoMap.set(cell.geo, scorePerGeo({ eligible: cell.eligible }, componentWeights));
  }

  // 1. Region-blend each method (carry sub-scores), then method-blend → overall.
  const perMethodRegionBlended = new Map<string, ScoredProvider[]>();
  for (const [method, geoMap] of scoredByMethodGeo) {
    perMethodRegionBlended.set(
      method,
      blendRegionScores(geoMap, regionWeights, { subs: true }),
    );
  }
  const { ranked, coverage } = blendMethodScores(
    perMethodRegionBlended,
    methodWeights,
    minCoverage,
  );
  const blendedById = new Map(ranked.map((s) => [s.provider_id, s]));

  // 2. Per-geo composite: method-blend within each geo (no coverage gate — a
  //    cell just shows whatever methods that geo has).
  const geoSet = new Set<GeoRegion>();
  for (const cell of cube) geoSet.add(cell.geo);
  const perGeoComposite = new Map<GeoRegion, Map<string, ScoredProvider>>();
  for (const geo of geoSet) {
    const perMethodInGeo = new Map<string, ScoredProvider[]>();
    for (const [method, geoMap] of scoredByMethodGeo) {
      const scored = geoMap.get(geo);
      if (scored && scored.length > 0) perMethodInGeo.set(method, scored);
    }
    const { ranked: geoRanked } = blendMethodScores(perMethodInGeo, methodWeights, 0);
    perGeoComposite.set(geo, new Map(geoRanked.map((s) => [s.provider_id, s])));
  }

  // 3. Sum/ratio aggregates + per-method drill-down, summed across (method, geo).
  //    n_challenges_with_winner is a per-(method,geo) denominator shared across
  //    providers (mirrors buildOverallLeaderRows), so sum rows[0] per cell.
  let totalChallengesWithWinner = 0;
  for (const cell of cube) {
    totalChallengesWithWinner += cell.rows[0]?.n_challenges_with_winner ?? 0;
  }

  return BENCHMARKED_PROVIDERS.map((provider) => {
    const s = blendedById.get(provider.id);
    const flags = provider.anti_gaming_flags ?? [];
    const cov = coverage.get(provider.id) ?? 0;
    const coverageOk = s != null;

    let totalWins = 0;
    let totalCalls = 0;
    let totalFailed = 0;
    const failByCat = new Map<string, number>();
    // Per-method: region-blended score + sample-weighted real p50/p95.
    const per_method: PresetLeaderRow["per_method"] = {};
    const pmAccum = new Map<string, { wSum: number; wP50: number; wP95: number }>();

    for (const cell of cube) {
      const r = cell.rows.find((x) => x.provider_id === provider.id);
      if (!r) continue;
      totalWins += r.n_wins ?? 0;
      totalCalls += r.sample_count_total ?? 0;
      totalFailed += r.sample_count_failed ?? 0;
      for (const f of r.failure_breakdown ?? []) {
        failByCat.set(f.category, (failByCat.get(f.category) ?? 0) + f.n);
      }
      const w = r.sample_count_valid ?? 0;
      if (w > 0 && r.p50_ms != null && r.p95_ms != null) {
        const acc = pmAccum.get(cell.method) ?? { wSum: 0, wP50: 0, wP95: 0 };
        acc.wSum += w;
        acc.wP50 += r.p50_ms * w;
        acc.wP95 += r.p95_ms * w;
        pmAccum.set(cell.method, acc);
      }
    }

    for (const [method, mb] of perMethodRegionBlended) {
      const mScore = mb.find((x) => x.provider_id === provider.id);
      const acc = pmAccum.get(method);
      per_method[method] = mScore
        ? {
            total: mScore.total,
            p50: acc && acc.wSum > 0 ? acc.wP50 / acc.wSum : null,
            p95: acc && acc.wSum > 0 ? acc.wP95 / acc.wSum : null,
          }
        : null;
    }

    const per_geo: PresetLeaderRow["per_geo"] = {};
    for (const geo of geoSet) {
      const gc = perGeoComposite.get(geo)?.get(provider.id);
      per_geo[geo] = gc
        ? {
            total: gc.total,
            latency_sub: gc.latency,
            win_sub: gc.winRate,
            reliability_sub: gc.reliability,
            correctness_sub: gc.correctness,
            freshness_sub: gc.freshness,
          }
        : null;
    }

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
      coverage_pct: cov,
      coverage_ok: coverageOk,
      exclusion_reason: coverageOk ? null : "insufficient method coverage",
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
      per_method,
    };
  }).sort((a, b) => {
    // Ranked (gate-cleared) first by score desc; insufficient-coverage last.
    if (a.coverage_ok !== b.coverage_ok) return a.coverage_ok ? -1 : 1;
    return b.total - a.total;
  });
}

// ---------------------------------------------------------------------------
// Mini score board (Performance page) — the same overall-score ranking the
// Overview shows, but computed from the Performance page's already-fetched
// per-geo aggregates so it tracks the active chart filters. Reuses the exact
// scoring builders above so the math can't drift from the Overview.
// ---------------------------------------------------------------------------

export interface MiniScoreRow {
  provider_id: string;
  provider_name: string;
  total: number;
}

/**
 * Ranked 0–100 overall scores for a compact strip. `selectedGeo` null →
 * region-blended Overall (DEFAULT_REGION_WEIGHTS), exactly like the Overview;
 * a specific geo → that region's single-geo scores. Rows come back sorted by
 * total desc, one per benchmarked provider (ineligible → total 0). Returns []
 * when the selected geo isn't present in `perGeo` (e.g. a hand-typed URL).
 */
export function buildMiniScoreRows(
  perGeo: { geo: GeoRegion; rows: RowAgg[] }[],
  selectedGeo: GeoRegion | null,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): MiniScoreRow[] {
  const outcomes: PerGeoOutcome[] = perGeo.map(({ geo, rows }) => {
    const eligible = rows.filter(
      (r) => r.eligible === true && r.p50_ms != null && r.p95_ms != null,
    );
    return { geo, rows, eligible, scored: scorePerGeo({ eligible }, weights) };
  });

  if (selectedGeo) {
    const outcome = outcomes.find((o) => o.geo === selectedGeo);
    if (!outcome) return [];
    return buildSingleLeaderRows(outcome).rows.map((r) => ({
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      total: r.total,
    }));
  }

  const map = new Map(outcomes.map((o) => [o.geo, o.scored]));
  const blended = blendRegionScores(map, DEFAULT_REGION_WEIGHTS);
  return buildOverallLeaderRows(blended, outcomes).map((r) => ({
    provider_id: r.provider_id,
    provider_name: r.provider_name,
    total: r.total,
  }));
}
