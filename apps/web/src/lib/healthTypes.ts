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
 * Independent auditor (utility endpoint) snapshot. Drives the "Auditor" chip
 * on the fleet-health strip — operators see at a glance whether the
 * cross-check is running (consensus-only scoring would be silent without
 * this surfaced).
 */
export interface AuditorHealth {
  last_ok_at: string | Date | null;
  /** True if any endpoint in the failover chain has a recent (<2 min) OK. */
  healthy: boolean;
  /** True if any endpoint's circuit is currently open (operator alert). */
  any_open: boolean;
  /**
   * Finality-verified consensus-accuracy: % of audited challenges where the
   * stored consensus reference matched the auditor's re-fetch after the
   * target slot finalized (immutable). null until the audit job runs.
   */
  consensus_accuracy_pct: number | null;
  /** Number of challenges that contribute to the accuracy %. */
  consensus_audited_n: number;
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
