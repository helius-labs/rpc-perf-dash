/**
 * getInflationGovernor — Archetype A (deterministic byte-equal).
 *
 * Returns governance inflation parameters (initial, terminal, taper,
 * foundation, foundationTerm). These are protocol constants that change only by
 * governance, stable across providers within any window. No input. Byte-equal.
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
export type GetInflationGovernorParams = Record<string, never>;

interface GetInflationGovernorResponse {
  initial?: number;
  terminal?: number;
  taper?: number;
  foundation?: number;
  foundationTerm?: number;
}

function projectImpl(response: GetInflationGovernorResponse): CanonicalProjection {
  const shape = {
    initial: response?.initial ?? null,
    terminal: response?.terminal ?? null,
    taper: response?.taper ?? null,
    foundation: response?.foundation ?? null,
    foundationTerm: response?.foundationTerm ?? null,
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetInflationGovernorParams, GetInflationGovernorResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
