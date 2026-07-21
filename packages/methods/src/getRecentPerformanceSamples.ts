/**
 * getRecentPerformanceSamples — well-formedness-only (Archetype D fallback).
 *
 * Returns the last N per-slot performance samples. Each provider samples at its
 * OWN slots (~150 slots / 60s apart) with essentially ZERO overlap across
 * providers, so a Jaccard-on-sample-slots approach never converges (maj=1). As a
 * fallback, it is scored like the node-identity methods: project a BOOLEAN
 * well-formedness verdict (an array of ≥1 samples, each with finite
 * numTransactions / numSlots /
 * samplePeriodSecs / slot). Serving providers all hash `true` → byte-equal
 * consensus → correct; a malformed-but-200 body dissents. Measures availability
 * + structural well-formedness, not cross-provider sample equality.
 */

import {
  byteEqualHash,
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";

export const BUCKETS = ["default"] as const;
/** Number of samples requested per challenge. */
const SAMPLE_LIMIT = 30;

export type GetRecentPerformanceSamplesParams = { limit: number };

interface PerfSample {
  slot?: number;
  numTransactions?: number;
  numSlots?: number;
  samplePeriodSecs?: number;
}
type GetRecentPerformanceSamplesResponse = PerfSample[];

function wellFormed(response: GetRecentPerformanceSamplesResponse): boolean {
  if (!Array.isArray(response) || response.length === 0) return false;
  return response.every(
    (s) =>
      Number.isFinite(s?.slot) &&
      Number.isFinite(s?.numTransactions) &&
      Number.isFinite(s?.numSlots) &&
      Number.isFinite(s?.samplePeriodSecs),
  );
}

function projectImpl(response: GetRecentPerformanceSamplesResponse): CanonicalProjection {
  const shape = { wellFormed: wellFormed(response) };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetRecentPerformanceSamplesParams, GetRecentPerformanceSamplesResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { limit: SAMPLE_LIMIT }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
