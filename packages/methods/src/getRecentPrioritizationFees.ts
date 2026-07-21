/**
 * getRecentPrioritizationFees — well-formedness-only (Archetype D, like
 * getRecentPerformanceSamples).
 *
 * Returns recent per-slot prioritization fees. Each provider reports fees from
 * its OWN recently-observed slots, and the windows are largely disjoint across
 * providers (and the per-slot fee is node-local), so a value/Jaccard cross-check
 * never converges — same situation as getRecentPerformanceSamples. So we score
 * it on availability + structure: project a BOOLEAN well-formedness verdict (a
 * non-empty array of entries each with a finite `slot` and `prioritizationFee`).
 * Serving providers all hash `true` → byte-equal consensus → correct; a
 * malformed-but-200 body dissents → incorrect.
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
/** No addresses → network-wide recent fees. */
export type GetRecentPrioritizationFeesParams = Record<string, never>;

interface PrioritizationFee {
  slot?: number;
  prioritizationFee?: number;
}
type GetRecentPrioritizationFeesResponse = PrioritizationFee[];

function wellFormed(response: GetRecentPrioritizationFeesResponse): boolean {
  if (!Array.isArray(response) || response.length === 0) return false;
  return response.every(
    (e) => Number.isFinite(e?.slot) && Number.isFinite(e?.prioritizationFee),
  );
}

function projectImpl(response: GetRecentPrioritizationFeesResponse): CanonicalProjection {
  const shape = { wellFormed: wellFormed(response) };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<
  GetRecentPrioritizationFeesParams,
  GetRecentPrioritizationFeesResponse
> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
