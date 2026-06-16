/**
 * Fleet-status grading shared by the header status dot (/api/fleet-status)
 * and the /status ProviderHealth strip. One copy of the thresholds so the
 * header dot and the status page can't drift.
 */

import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import type {
  BenchmarkedHealth,
  AuditorHealth,
  InfraVantageHealth,
} from "@/lib/healthTypes";

export type FleetStatus = "ok" | "degraded" | "down" | "absent";

/**
 * Correctness grading for a benchmarked provider, by share of correct samples
 * in the window. Shared by the ProviderHealth strip and the header-pill
 * summary so the two can't drift.
 */
export function statusForBenchmarked(b: BenchmarkedHealth): FleetStatus {
  if (b.n_samples === 0) return "absent";
  const successPct = b.n_correct / b.n_samples;
  if (successPct >= 0.9) return "ok";
  if (successPct >= 0.3) return "degraded";
  return "down";
}

export function statusForInfra(
  staleness_s: number | null,
  n_samples_15m: number,
): FleetStatus {
  // Heartbeat-first: if the worker isn't beating, it's down regardless of
  // sample history (an old heartbeat means the process died).
  if (staleness_s === null) return "absent";
  if (staleness_s > 30) return "down";
  // Heartbeat is fresh — now check whether work is flowing. A worker that
  // heartbeats but never claims a challenge (e.g. generator stopped fanning
  // out to it) is "degraded", not OK.
  if (n_samples_15m === 0) return "degraded";
  return "ok";
}

/**
 * Headline status for the whole fleet. Green when broadly healthy, yellow
 * when partially up, red when nothing is reporting. Graded on the share of
 * live vantages (a single momentarily-quiet lane shouldn't turn it yellow)
 * and intentionally not gated on the auditor — its health signal is
 * noisy/secondary and surfaced in full on /status.
 */
export function gradeFleet(
  infra: ReadonlyArray<{ staleness_s: number | null; n_samples_15m: number }>,
): FleetStatus {
  if (infra.length === 0) return "absent";
  const live = infra.filter(
    (i) => statusForInfra(i.staleness_s, i.n_samples_15m) === "ok",
  ).length;
  const ratio = live / infra.length;
  if (ratio >= 0.7) return "ok";
  if (ratio > 0) return "degraded";
  return "down";
}

export const FLEET_DOT: Record<FleetStatus, string> = {
  ok: "#7be0a4",
  degraded: "#f3c27a",
  down: "#f08080",
  absent: "#666",
};

/**
 * Compact fleet snapshot for the header Status-pill tooltip. A glanceable
 * preview of /status: overall headline + a few counts, derived from the same
 * ProviderHealth snapshot the /status strip renders.
 */
export interface FleetSummary {
  status: FleetStatus;
  infra: { live: number; total: number };
  auditor: { healthy: boolean };
  benchmarked: { healthy: number; total: number };
}

export function buildFleetSummary(health: {
  benchmarked: BenchmarkedHealth[];
  auditor: Pick<AuditorHealth, "healthy">;
  infra: InfraVantageHealth[];
}): FleetSummary {
  const infraLive = health.infra.filter(
    (i) => statusForInfra(i.staleness_s, i.n_samples_15m) === "ok",
  ).length;

  // Denominator is the full configured panel (matching the ProviderHealth
  // strip), not just providers that happened to have samples this window —
  // health.benchmarked only carries rows for providers with ≥1 sample.
  const panel = BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked);
  const benchHealthy = panel.filter((p) => {
    const row = health.benchmarked.find((b) => b.provider_id === p.id);
    return row != null && statusForBenchmarked(row) === "ok";
  }).length;

  return {
    status: gradeFleet(health.infra),
    infra: { live: infraLive, total: health.infra.length },
    auditor: { healthy: health.auditor.healthy },
    benchmarked: { healthy: benchHealthy, total: panel.length },
  };
}
