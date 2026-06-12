/**
 * Workload-persona presets for the Overview leaderboard.
 *
 * These model real Solana use-case personas rather than abstract speed /
 * reliability axes, so a layman can pick "the one that's me" and watch the
 * board re-rank. Each preset is just a set of L/W/R/C/F scoring weights that
 * feed the existing client-side re-score in IndexLeaderboard (no refetch).
 *
 * Every `weights` vector sums to 1.0. Balanced === DEFAULT_WEIGHTS, so the
 * default landing view matches the documented methodology exactly.
 *
 * NOTE: the non-Balanced vectors are starting points, not measured optima.
 * They're meant to move the board in the persona's named direction; tune them
 * if a preset doesn't rank the way its label promises.
 */

import { DEFAULT_WEIGHTS, type ScoringWeights } from "@rpcbench/shared/scoring";

export interface WorkloadPreset {
  id: string;
  label: string;
  /** Compact label for the on-page chips (so all presets fit one line on mobile). */
  short: string;
  /** One-line plain-language summary of what the persona optimizes for. */
  caption: string;
  weights: ScoringWeights;
}

export const WORKLOAD_PRESETS: readonly WorkloadPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    short: "Balanced",
    caption: "Even weighting across speed, reliability, and correctness.",
    weights: DEFAULT_WEIGHTS, // 0.25 L / 0.25 W / 0.25 R / 0.20 C / 0.05 F
  },
  {
    id: "trading-bot",
    label: "Trading bot",
    short: "Trading",
    caption: "Speed-first: lowest latency and most often the fastest correct answer.",
    weights: { latency: 0.4, winRate: 0.3, reliability: 0.1, correctness: 0.05, freshness: 0.15 },
  },
  {
    id: "data-analytics",
    label: "Data / analytics",
    short: "Analytics",
    caption: "Correctness-first: accurate, complete reads over raw speed.",
    weights: { latency: 0.05, winRate: 0.0, reliability: 0.35, correctness: 0.5, freshness: 0.1 },
  },
  {
    id: "tx-sending",
    label: "Transaction sending",
    short: "Sending",
    caption: "Reliability-first: answers that always land, fast enough to act on.",
    weights: { latency: 0.3, winRate: 0.1, reliability: 0.45, correctness: 0.1, freshness: 0.05 },
  },
] as const;

export const DEFAULT_PRESET_ID = "balanced";

/** Find the preset whose weights match `w` exactly (so the UI can highlight the
 *  active pill when weights came from a preset rather than the raw sliders). */
export function presetIdForWeights(w: ScoringWeights): string | null {
  for (const p of WORKLOAD_PRESETS) {
    if (
      p.weights.latency === w.latency &&
      p.weights.winRate === w.winRate &&
      p.weights.reliability === w.reliability &&
      p.weights.correctness === w.correctness &&
      p.weights.freshness === w.freshness
    ) {
      return p.id;
    }
  }
  return null;
}
