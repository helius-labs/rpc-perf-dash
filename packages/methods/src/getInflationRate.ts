/**
 * getInflationRate — Archetype A (deterministic byte-equal).
 *
 * Returns `{ epoch, total, validator, foundation }` — the inflation rate for
 * the current epoch, computed deterministically from the inflation curve, so
 * every provider in the same epoch returns identical figures. No input.
 * Byte-equal consensus + auditor. (At an epoch boundary two providers can
 * straddle epochs and disagree → ambiguous, dropped — rare and acceptable.)
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
export type GetInflationRateBucket = (typeof BUCKETS)[number];

export interface GetInflationRateParams {}

interface GetInflationRateResponse {
  epoch?: number;
  total?: number;
  validator?: number;
  foundation?: number;
}

function projectImpl(response: GetInflationRateResponse): CanonicalProjection {
  const shape = {
    epoch: response?.epoch ?? null,
    total: response?.total ?? null,
    validator: response?.validator ?? null,
    foundation: response?.foundation ?? null,
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetInflationRateParams, GetInflationRateResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
