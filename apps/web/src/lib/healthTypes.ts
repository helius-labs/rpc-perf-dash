/**
 * Shared fleet-health data shapes. Extracted from ProviderHealth.tsx so the
 * component, the lib fetcher (health.ts), and the fleet-status grading
 * (fleetStatus.ts) can all reference one copy without importing the React
 * component (which would create a fleetStatus ↔ ProviderHealth cycle).
 */

export interface BenchmarkedHealth {
  provider_id: string;
  n_samples: number;
  n_correct: number;
  p95_ms: number | null;
  latest: string | Date | null;
}

/**
 * Utility endpoint (the generator's chain-observation RPC) liveness snapshot.
 * Drives the "Utility" chip on the fleet-health strip — if this endpoint is
 * down, the generator can't derive challenges, so operators need it surfaced.
 */
export interface UtilityHealth {
  last_ok_at: string | Date | null;
  /** True if any endpoint in the failover chain has a recent (<2 min) OK. */
  healthy: boolean;
  /** True if any endpoint's circuit is currently open (operator alert). */
  any_open: boolean;
}

export interface InfraVantageHealth {
  worker_provider: string;
  region: string;
  egress_path: string;
  beat_at: string | Date | null;
  staleness_s: number | null;
  n_samples_15m: number;
  latest_sample_at: string | Date | null;
}
