/**
 * getStakeMinimumDelegation — Archetype A (deterministic byte-equal).
 *
 * Returns the minimum stake delegation in lamports (context-wrapped
 * `{ context, value }`). A network constant — fixed by the protocol — so every
 * provider returns the identical value. No input. We hash `value` only (the
 * context.slot drifts and is irrelevant to this constant).
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
export type GetStakeMinimumDelegationParams = Record<string, never>;

interface GetStakeMinimumDelegationResponse {
  context?: { slot?: number };
  value: number | null;
}

function projectImpl(response: GetStakeMinimumDelegationResponse): CanonicalProjection {
  const value = typeof response?.value === "number" ? response.value : null;
  const shape = { value };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetStakeMinimumDelegationParams, GetStakeMinimumDelegationResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
