/**
 * Independent auditor (utility-RPC) reference fetching.
 *
 * Methodology_version 2 replaces the rotating neutral quorum with majority
 * consensus across the benchmarked panel. The utility endpoint is repurposed
 * as a single neutral AUDITOR whose answer is recorded per challenge as the
 * `reference_response` / `reference_hash` / `reference_tip_slot` columns:
 *
 *   - The worker's record.ts cross-checks panel consensus against this
 *     reference. A disagreement marks every sample for the challenge as
 *     `consensus_disputed` (excluded from scoring).
 *   - Used to derive freshness_lag = reference_tip - provider_tip for every
 *     sample.
 *   - The deferred finality re-verification job (rollup.ts) re-queries the
 *     auditor once challenges are deeply finalized and writes the result to
 *     consensus_audit.
 *
 * Replaces apps/generator/src/quorum.ts (deleted).
 */

import { HANDLERS } from "@rpcbench/methods";
import type { Method } from "@rpcbench/shared";
import type { MultiEndpointRpcClient } from "./utility-client.js";

/**
 * Per-call utility timeout for ARCHIVAL-bucket reference fetches (cold
 * archive reads, multi-MB getBlock-full bodies). 12s — paired with the 12s
 * archival derive budget so a tickCombo's derive + auditor worst case stays
 * ≈ 24s under the generator's 25s tick ceiling. Non-archival buckets keep
 * the client's 5s default.
 */
export const AUDITOR_ARCHIVAL_TIMEOUT_MS = 12_000;

export function auditorCallOptsForBucket(bucket: string): { timeoutMs: number } | undefined {
  return bucket === "honeypot" || bucket.includes("archival")
    ? { timeoutMs: AUDITOR_ARCHIVAL_TIMEOUT_MS }
    : undefined;
}

export interface AuditorReference {
  /** Raw RPC response payload. Stored on challenges.reference_response. */
  response: unknown;
  /** Canonical projection hash. Stored on challenges.reference_hash. */
  hash: Buffer;
  /** Tip slot captured at the same time (for freshness_lag). */
  tip_slot: bigint;
}

/**
 * Fetch the auditor's answer to a (method, params) challenge.
 *
 * Returns null if every utility endpoint failed — the generator treats this
 * as a soft failure: it stores `reference_hash = ∅` and the worker marks each
 * sample's exclusion_reason as `auditor_unavailable` (still scored on
 * consensus alone, so a brief utility outage doesn't mass-zero correctness).
 */
export async function fetchAuditorReference(
  utility: MultiEndpointRpcClient,
  method: Method,
  params: readonly unknown[],
  tipSlot: bigint,
  opts?: { timeoutMs?: number },
): Promise<AuditorReference | null> {
  let response: unknown;
  try {
    response = await utility.call(method, params as unknown[], opts);
  } catch {
    return null;
  }
  const projection = HANDLERS[method].project(response);
  return {
    response,
    hash: Buffer.from(projection.hash),
    tip_slot: tipSlot,
  };
}
