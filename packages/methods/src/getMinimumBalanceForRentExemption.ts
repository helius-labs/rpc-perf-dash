/**
 * getMinimumBalanceForRentExemption — Archetype A (deterministic byte-equal).
 *
 * Returns the rent-exempt minimum lamports for an account of a given data size.
 * It's a pure network constant per size (rent params are fixed), so every
 * provider returns the identical number. We challenge a few representative sizes
 * (empty account, classic SPL token account, classic mint) as buckets.
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
import { SPL_TOKEN_ACCOUNT_SIZE, SPL_MINT_SIZE } from "./spl.js";

export const BUCKETS = ["zero", "token", "mint"] as const;
export type GetMinimumBalanceForRentExemptionBucket = (typeof BUCKETS)[number];

const SIZE_FOR_BUCKET: Record<GetMinimumBalanceForRentExemptionBucket, number> = {
  zero: 0,
  token: SPL_TOKEN_ACCOUNT_SIZE,
  mint: SPL_MINT_SIZE,
};

export interface GetMinimumBalanceForRentExemptionParams {
  dataSize: number;
}

type GetMinimumBalanceForRentExemptionResponse = number;

function projectImpl(response: GetMinimumBalanceForRentExemptionResponse): CanonicalProjection {
  const lamports = typeof response === "number" ? response : null;
  const shape = { lamports };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<
  GetMinimumBalanceForRentExemptionParams,
  GetMinimumBalanceForRentExemptionResponse
> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    const bucket = ctx.bucket as GetMinimumBalanceForRentExemptionBucket;
    return { params: { dataSize: SIZE_FOR_BUCKET[bucket] }, bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
