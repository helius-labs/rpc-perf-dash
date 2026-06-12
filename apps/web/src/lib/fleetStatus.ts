/**
 * Fleet-status grading shared by the header status dot (/api/fleet-status)
 * and the /status ProviderHealth strip. One copy of the thresholds so the
 * header dot and the status page can't drift.
 */

export type FleetStatus = "ok" | "degraded" | "down" | "absent";

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
