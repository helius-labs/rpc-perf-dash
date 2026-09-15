/**
 * Frozen copy of the send leaderboard, rendered by /embed/sends-snapshot.
 *
 * GENERATED — do not hand-edit. Run `pnpm snapshot:sends --write`, review the
 * diff, and land it as a PR. Hand-editing risks a date that doesn't match the
 * numbers, which is the one failure mode this whole file exists to prevent.
 *
 * The embed prints `asOf` next to the rows and links to the live board, so a
 * snapshot that stops being refreshed reads as visibly stale rather than as a
 * current claim.
 */

import type { SendsLeaderboardRow } from "@/components/SendsLeaderboard";

export interface SendsSnapshot {
  /** The day the rows cover (UTC, from the API's window_start) — NOT the
   *  generation date, and NOT window_end, which is the exclusive bound. */
  asOf: string;
  /** Rollup grain the rows were scored over — a COMPLETED bucket. */
  grain: "1h" | "1d";
  rows: SendsLeaderboardRow[];
}

export const SENDS_SNAPSHOT: SendsSnapshot = {
  asOf: "2026-09-14",
  grain: "1d",
  rows: [
    {
      rank: 1,
      send_target: "helius",
      total: 99.73,
      landing_rate: 0.99504,
      slot_latency_p50: 4.98,
      slot_latency_p95: 6.32,
      cost_lamports: 5775,
      sample_count_total: 1784,
      outcomes: { landed: 1827, reverted: 0, not_landed: 10, submit_error: 0 },
    },
    {
      rank: 2,
      send_target: "triton",
      total: 99.14,
      landing_rate: 0.99609,
      slot_latency_p50: 5,
      slot_latency_p95: 6.49,
      cost_lamports: 5775,
      sample_count_total: 1784,
      outcomes: { landed: 1829, reverted: 0, not_landed: 8, submit_error: 0 },
    },
    {
      rank: 3,
      send_target: "alchemy",
      total: 96.68,
      landing_rate: 0.99609,
      slot_latency_p50: 5.21,
      slot_latency_p95: 6.97,
      cost_lamports: 5775,
      sample_count_total: 1783,
      outcomes: { landed: 1828, reverted: 0, not_landed: 8, submit_error: 0 },
    },
    {
      rank: 4,
      send_target: "quicknode",
      total: 84.86,
      landing_rate: 0.95772,
      slot_latency_p50: 5.72,
      slot_latency_p95: 11.29,
      cost_lamports: 5775,
      sample_count_total: 1784,
      outcomes: { landed: 1765, reverted: 0, not_landed: 72, submit_error: 0 },
    },
    {
      rank: 5,
      send_target: "chainstack",
      total: 84.81,
      landing_rate: 0.97636,
      slot_latency_p50: 6.54,
      slot_latency_p95: 10.17,
      cost_lamports: 5775,
      sample_count_total: 1784,
      outcomes: { landed: 1779, reverted: 0, not_landed: 53, submit_error: 5 },
    },
  ],
};
