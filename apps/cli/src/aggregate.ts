/**
 * Per-provider aggregation + scoring adapter.
 *
 * Adapted from apps/generator/src/benchmark.ts `aggregate()`. The percentile /
 * win-rate / correctness-rate math is unchanged; the ONLY structural change is
 * the outer loop iterates the user's `{ id, name }` list instead of the
 * env-driven `CONFIGURED_BENCHMARKED()` roster (which is empty in a BYO clone,
 * and would collapse scoring to []).
 */

import type { ProviderMetrics } from "@rpcbench/shared";
import type { SampleRow } from "@rpcbench/db";
import type { BenchProvider } from "./fanout.js";

export interface ProviderAggregate {
  provider_id: string;
  name: string;
  n_total: number;
  n_correct: number;
  /** correct + incorrect + stale — the correctness denominator. 0 → n/a. */
  n_validated: number;
  p50_cold: number | null;
  p95_cold: number | null;
  p99_cold: number | null;
  p50_warm: number | null;
  p95_warm: number | null;
  p99_warm: number | null;
  success_rate: number;
  correctness_rate: number;
  freshness_p95_lag: number | null;
  n_wins: number;
  n_challenges_with_winner: number;
}

export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export function aggregate(
  rows: readonly SampleRow[],
  providers: readonly BenchProvider[],
): ProviderAggregate[] {
  const byProvider = new Map<string, SampleRow[]>();
  for (const r of rows) {
    const arr = byProvider.get(r.provider_id) ?? [];
    arr.push(r);
    byProvider.set(r.provider_id, arr);
  }

  // Win-rate: per challenge, the fastest cold+correct provider wins.
  const winsByProvider = new Map<string, number>();
  const challengeBest = new Map<string, { provider_id: string; latency_ms: number }>();
  for (const r of rows) {
    if (r.connection_mode !== "cold" || r.correctness !== "correct") continue;
    const cur = challengeBest.get(r.challenge_id);
    if (!cur || r.latency_ms < cur.latency_ms) {
      challengeBest.set(r.challenge_id, { provider_id: r.provider_id, latency_ms: r.latency_ms });
    }
  }
  for (const { provider_id } of challengeBest.values()) {
    winsByProvider.set(provider_id, (winsByProvider.get(provider_id) ?? 0) + 1);
  }
  const totalChallengesWithWinner = challengeBest.size;

  const out: ProviderAggregate[] = [];
  for (const provider of providers) {
    const list = byProvider.get(provider.id) ?? [];
    // Latency + reliability are over SUCCESSFUL responses (status "ok"), not
    // correctness-gated — otherwise latency-only mode (1–2 endpoints, no
    // consensus) shows all-null because nothing is ever "correct". Correctness%,
    // win-rate, and score stay correctness-gated below.
    const cold = list.filter((r) => r.connection_mode === "cold" && r.status === "ok");
    const warm = list.filter((r) => r.connection_mode === "warm" && r.status === "ok");
    const sortedColdLat = cold.map((r) => r.latency_ms).sort((a, b) => a - b);
    const sortedWarmLat = warm.map((r) => r.latency_ms).sort((a, b) => a - b);
    const correctRows = list.filter((r) => r.correctness === "correct");
    const okRows = list.filter((r) => r.status === "ok");
    const validatedRows = list.filter(
      (r) =>
        r.correctness === "correct" ||
        r.correctness === "incorrect" ||
        r.correctness === "stale",
    );
    const lagSorted = correctRows
      .map((r) => Number(r.freshness_lag ?? 0n))
      .sort((a, b) => a - b);

    out.push({
      provider_id: provider.id,
      name: provider.name,
      n_total: list.length,
      n_correct: correctRows.length,
      n_validated: validatedRows.length,
      p50_cold: percentile(sortedColdLat, 0.5),
      p95_cold: percentile(sortedColdLat, 0.95),
      p99_cold: percentile(sortedColdLat, 0.99),
      p50_warm: percentile(sortedWarmLat, 0.5),
      p95_warm: percentile(sortedWarmLat, 0.95),
      p99_warm: percentile(sortedWarmLat, 0.99),
      success_rate: list.length === 0 ? 0 : okRows.length / list.length,
      correctness_rate: validatedRows.length === 0 ? 0 : correctRows.length / validatedRows.length,
      freshness_p95_lag: percentile(lagSorted, 0.95),
      n_wins: winsByProvider.get(provider.id) ?? 0,
      n_challenges_with_winner: totalChallengesWithWinner,
    });
  }
  return out;
}

/**
 * Providers with at least one correct cold sample are score-eligible; the rest
 * show as "ineligible" (latency/reliability still visible in the table).
 */
export function toMetrics(aggregates: readonly ProviderAggregate[]): ProviderMetrics[] {
  return aggregates
    .filter((a) => a.n_correct > 0 && a.p95_cold !== null && a.p50_cold !== null)
    .map((a) => ({
      provider_id: a.provider_id,
      p50_latency_ms: a.p50_cold!,
      p95_latency_ms: a.p95_cold!,
      success_rate: a.success_rate,
      correct_count: a.n_correct,
      validated_count: a.n_correct,
      freshness_p95_lag: a.freshness_p95_lag ?? 1,
      n_wins: a.n_wins,
      n_challenges_with_winner: a.n_challenges_with_winner,
    }));
}
