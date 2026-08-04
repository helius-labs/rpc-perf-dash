/**
 * Send-board scoring — a parallel scorer to the read `scoring.ts`, so the read
 * 5-axis scorer stays untouched. Two axes:
 *   R_send  landing rate  → reliability (direct percentage)
 *   L_send  slot latency  → latency     (best-normalized p50/p95 blend)
 *
 * Block position was dropped: it can only be derived from a full-block stream
 * (Yellowstone), and sends confirm via plain getSignatureStatuses polling, which
 * doesn't expose it. Landing rate + slot latency are the scored axes.
 *
 * Zero guard mirrors scoring.ts:132's freshness `Math.max(1, …)` — `slot_latency
 * = 0` (same-slot land) is routine and would otherwise NaN-out or zero every
 * target.
 *
 * See docs/methodology.md § Transaction sends.
 */

import { clamp } from "./scoring.js";

export interface SendScoringWeights {
  reliability: number;
  latency: number;
}

/** Reliability-dominant because landing is the point. */
export const DEFAULT_SEND_WEIGHTS: SendScoringWeights = {
  reliability: 0.55,
  latency: 0.45,
};

export interface SendTargetMetrics {
  send_target: string;
  /** landed / (landed + reverted + not_landed + submit_error), 0..1. */
  landing_rate: number;
  slot_latency_p50: number;
  slot_latency_p95: number;
}

export interface ScoredSendTarget {
  send_target: string;
  total: number;
  reliability: number;
  latency: number;
}

export function scoreSends(
  metrics: readonly SendTargetMetrics[],
  weights: SendScoringWeights = DEFAULT_SEND_WEIGHTS,
): ScoredSendTarget[] {
  if (metrics.length === 0) return [];

  const best_l50 = Math.min(...metrics.map((m) => Math.max(1, m.slot_latency_p50)));
  const best_l95 = Math.min(...metrics.map((m) => Math.max(1, m.slot_latency_p95)));

  const wSum = weights.reliability + weights.latency;
  const norm = wSum > 0 ? wSum : 1;

  return metrics.map((m) => {
    const R = clamp(m.landing_rate * 100, 0, 100);
    const L =
      0.5 * clamp((best_l50 / Math.max(1, m.slot_latency_p50)) * 100, 0, 100) +
      0.5 * clamp((best_l95 / Math.max(1, m.slot_latency_p95)) * 100, 0, 100);
    const total = (weights.reliability * R + weights.latency * L) / norm;
    return { send_target: m.send_target, total, reliability: R, latency: L };
  });
}
