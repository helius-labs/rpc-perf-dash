/**
 * Scoring formulas — must match `methodology.md` § Score formulas.
 *
 *   L_score = 0.5 · clamp(0..100, best_p50 / provider_p50 * 100)
 *           + 0.5 · clamp(0..100, best_p95 / provider_p95 * 100)
 *             # Blends "usually fast" (p50) with "tight tail" (p95).
 *             # p50-only would ignore tail latency; p95-only ignores median.
 *   W_score = clamp(0..100, provider_win_rate / best_win_rate * 100)
 *             # Win rate = fraction of challenges where this provider had the
 *             # lowest-latency correct sample. Normalized to best so the leader
 *             # pins to 100 (same shape as L/F).
 *             # If best_win_rate == 0 (no provider ever wins — degenerate),
 *             # W=100 for everyone (component contributes nothing useful).
 *   R_score = success_rate * 100
 *             # success_rate excludes ambiguous from denominator
 *             # HTTP 200 with `incorrect` data counts as RELIABLE (server responded)
 *             #   but NOT correct.
 *   C_score = correct / validated * 100
 *             # validated = correct + incorrect + stale (excludes ambiguous AND
 *             # incomplete — completeness is its own metric)
 *   F_score = clamp(0..100, best_freshness_p95_lag / provider_freshness_p95_lag * 100)
 *             # if best == 0, all-tied at 100; else use numerator floor of 1.
 *
 *   total = 0.25 L + 0.25 W + 0.25 R + 0.20 C + 0.05 F
 */

import { GEO_REGIONS, type GeoRegion } from "./types.js";

export interface ScoringWeights {
  latency: number;
  winRate: number;
  reliability: number;
  correctness: number;
  freshness: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  latency: 0.25,
  winRate: 0.25,
  reliability: 0.25,
  correctness: 0.2,
  freshness: 0.05,
};

/**
 * Per-geo-region weight used when blending per-region provider scores into a
 * single "overall" leaderboard ranking. Defaults bias toward EU Central and
 * NA East, which is where the largest share of Solana RPC traffic terminates.
 * Users can override via URL params (r_ne/r_eu/r_an/r_nw/r_ew/r_as).
 */
export type RegionWeights = Record<GeoRegion, number>;

export const DEFAULT_REGION_WEIGHTS: RegionWeights = {
  "na-east": 0.35,
  "eu-central": 0.35,
  "ap-northeast": 0.2,
  "na-west": 0.1,
  // No vantages deployed in these geos yet. Setting them to 0 keeps the
  // weights form summing to exactly 1.0 over the active subset. If vantages
  // come online here later, rebalance to give them a meaningful share.
  "eu-west": 0,
  "ap-southeast": 0,
};

export interface ProviderMetrics {
  provider_id: string;
  p50_latency_ms: number;
  p95_latency_ms: number;
  success_rate: number; // 0..1
  correct_count: number;
  validated_count: number; // correct + incorrect + stale
  freshness_p95_lag: number; // slots
  n_wins: number;
  n_challenges_with_winner: number;
}

export interface ScoredProvider {
  provider_id: string;
  total: number;
  latency: number;
  winRate: number;
  reliability: number;
  correctness: number;
  freshness: number;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function score(
  metrics: readonly ProviderMetrics[],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ScoredProvider[] {
  if (metrics.length === 0) return [];

  const best_p50 = Math.min(...metrics.map((m) => m.p50_latency_ms));
  const best_p95 = Math.min(...metrics.map((m) => m.p95_latency_ms));
  const best_freshness = Math.min(...metrics.map((m) => m.freshness_p95_lag));
  const winRates = metrics.map((m) =>
    m.n_challenges_with_winner > 0 ? m.n_wins / m.n_challenges_with_winner : 0,
  );
  const best_win_rate = Math.max(0, ...winRates);

  return metrics.map((m, i) => {
    const L_p50 = clamp((best_p50 / m.p50_latency_ms) * 100, 0, 100);
    const L_p95 = clamp((best_p95 / m.p95_latency_ms) * 100, 0, 100);
    const L = 0.5 * L_p50 + 0.5 * L_p95;
    const wr = winRates[i] ?? 0;
    // Normalized to best winner. If no provider has ever won (best==0), the W
    // component carries no information — give everyone W=100 so it doesn't
    // drag any score down unfairly.
    const W = best_win_rate === 0 ? 100 : clamp((wr / best_win_rate) * 100, 0, 100);
    const R = clamp(m.success_rate * 100, 0, 100);
    const C =
      m.validated_count === 0
        ? 0
        : clamp((m.correct_count / m.validated_count) * 100, 0, 100);
    // Freshness lag can be negative (provider's tip is briefly ahead of the
    // reference tip captured a moment earlier). Treat lag <= 0 as "perfectly
    // fresh" — F=100 — so we don't reward providers for being further behind
    // than the reference and don't surface negative scores.
    const providerLag = Math.max(0, m.freshness_p95_lag);
    const bestLag = Math.max(0, best_freshness);
    const F =
      bestLag === 0
        ? providerLag === 0
          ? 100
          : clamp((1 / providerLag) * 100, 0, 100)
        : clamp((bestLag / Math.max(1, providerLag)) * 100, 0, 100);

    const total = clamp(
      weights.latency * L +
        weights.winRate * W +
        weights.reliability * R +
        weights.correctness * C +
        weights.freshness * F,
      0,
      100,
    );

    return {
      provider_id: m.provider_id,
      total,
      latency: L,
      winRate: W,
      reliability: R,
      correctness: C,
      freshness: F,
    };
  });
}

/**
 * Blend per-geo-region scores into a single overall score per provider.
 *
 * Inputs: a Map<GeoRegion, ScoredProvider[]> (one already-scored set per region).
 *
 * Eligible-subset renormalization: a provider that's only eligible in EU + NA
 * shouldn't have its blend ceiling depressed by AP-Northeast's weight. So for
 * each provider, we re-normalize the weights over only the regions where that
 * provider appears.
 *
 * Returns one ScoredProvider per provider that's eligible in at least one
 * region, with `total` = weighted blend, and L/W/R/C/F left as 0 (they're
 * per-region quantities and don't blend meaningfully). Callers that need the
 * per-region breakdown should keep the original per-region scoring around.
 */
export function blendRegionScores(
  perRegion: Map<GeoRegion, readonly ScoredProvider[]>,
  weights: RegionWeights = DEFAULT_REGION_WEIGHTS,
): ScoredProvider[] {
  // For each provider, collect (region, score) and the weight it would draw.
  const byProvider = new Map<string, Array<{ region: GeoRegion; score: ScoredProvider }>>();
  for (const region of GEO_REGIONS) {
    const list = perRegion.get(region);
    if (!list) continue;
    for (const sp of list) {
      const arr = byProvider.get(sp.provider_id) ?? [];
      arr.push({ region, score: sp });
      byProvider.set(sp.provider_id, arr);
    }
  }

  const out: ScoredProvider[] = [];
  for (const [provider_id, entries] of byProvider) {
    const wSum = entries.reduce((acc, e) => acc + (weights[e.region] ?? 0), 0);
    if (wSum <= 0) continue;
    let total = 0;
    for (const e of entries) {
      const w = (weights[e.region] ?? 0) / wSum;
      total += w * e.score.total;
    }
    out.push({
      provider_id,
      total: clamp(total, 0, 100),
      latency: 0,
      winRate: 0,
      reliability: 0,
      correctness: 0,
      freshness: 0,
    });
  }
  // Sort by total desc for caller convenience.
  out.sort((a, b) => b.total - a.total);
  return out;
}
