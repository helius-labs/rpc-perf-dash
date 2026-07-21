/**
 * Head-to-head (A-vs-B) win-rate math. Pure (no DB/cache) so it's unit-testable
 * in the shared harness; the web read lib (apps/web/src/lib/headToHead.ts) wraps
 * this with the pairwise_wins query.
 *
 * Unlike the leaderboard's global win rate (fastest-correct across the WHOLE
 * panel), this is per-pair: of the challenges both providers answered correctly,
 * how often A was faster than B. "Overall" is a fixed-weight region blend
 * (DEFAULT_REGION_WEIGHTS) — NOT a traffic-weighted sum — so it agrees with every
 * other Overall figure on the site. A single geo is a passthrough
 * (blendRegionScalar over a one-entry map returns that geo's rate unchanged).
 */

import { blendRegionScalar, DEFAULT_REGION_WEIGHTS } from "./scoring.js";
import { type GeoRegion } from "./types.js";

/** One geo's summed pair counts (from the query, or a test fixture). */
export interface PairwiseGeoRow {
  geo: GeoRegion;
  a_wins: number;
  b_wins: number;
  n_contested: number;
}

export interface HeadToHeadResult {
  /** Region-blended (or single-geo) fraction of contested challenges A won, 0..1. */
  a_win_rate: number | null;
  b_win_rate: number | null;
  // Summed raw counts across the given geos — transparency only. The headline
  // rate is the region blend, NOT a_wins/(a_wins + b_wins) over these sums.
  a_wins: number;
  b_wins: number;
  n_contested: number;
}

/**
 * Blend per-geo raw win rates with DEFAULT_REGION_WEIGHTS, matching the site's
 * other Overall figures. Rates are null when no geo has a contested challenge.
 * `b_win_rate = 1 - a_win_rate` holds exactly: per-geo rates are complementary
 * and blendRegionScalar renormalizes over the same present geos for both sides.
 */
export function computeHeadToHead(rows: readonly PairwiseGeoRow[]): HeadToHeadResult {
  let aWins = 0;
  let bWins = 0;
  let contested = 0;
  const perGeoARate = new Map<GeoRegion, number>();
  for (const r of rows) {
    aWins += r.a_wins;
    bWins += r.b_wins;
    contested += r.n_contested;
    const denom = r.a_wins + r.b_wins;
    if (denom > 0) perGeoARate.set(r.geo, r.a_wins / denom);
  }
  const aRate = perGeoARate.size > 0 ? blendRegionScalar(perGeoARate, DEFAULT_REGION_WEIGHTS) : null;
  return {
    a_win_rate: aRate,
    b_win_rate: aRate == null ? null : 1 - aRate,
    a_wins: aWins,
    b_wins: bWins,
    n_contested: contested,
  };
}
