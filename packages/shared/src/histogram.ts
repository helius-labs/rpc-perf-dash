/**
 * Log-spaced latency-histogram bin domain — the single source of truth shared
 * by the generator (which writes per-bucket bin counts into latency_histogram_*)
 * and the web (which reads + renders them). They MUST agree on the domain or the
 * stored bins would be misinterpreted.
 *
 * 60 bins between 2ms and 2000ms. `width_bucket` returns 0 below the floor and
 * NBINS+1 above the ceiling; the generator clamps into [1, NBINS] so the edge
 * bins absorb the tails and Σ bins == n exactly.
 */
export const LATENCY_HIST = {
  L0: Math.log(2),
  L1: Math.log(2000),
  NBINS: 60,
} as const;

const STEP = (LATENCY_HIST.L1 - LATENCY_HIST.L0) / LATENCY_HIST.NBINS;

/** Geometric center latency (ms) of bin b (1..NBINS). */
export function latencyBinCenter(b: number): number {
  return Math.exp(LATENCY_HIST.L0 + (b - 0.5) * STEP);
}
/** Lower edge latency (ms) of bin b (1..NBINS). */
export function latencyBinLo(b: number): number {
  return Math.exp(LATENCY_HIST.L0 + (b - 1) * STEP);
}
/** Upper edge latency (ms) of bin b (1..NBINS). */
export function latencyBinHi(b: number): number {
  return Math.exp(LATENCY_HIST.L0 + b * STEP);
}

/** Companion histogram precompute grain for a window — mirrors
 *  leaderboardGrainForWindow (hourly ≤7d, daily beyond). Reads target the merged
 *  `latency_histogram` table filtered by this grain. */
export function latencyHistogramGrainForWindow(windowHours: number): "1h" | "1d" {
  return windowHours <= 168 ? "1h" : "1d";
}
