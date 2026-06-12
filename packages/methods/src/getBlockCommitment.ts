/**
 * getBlockCommitment — Archetype A (deterministic byte-equal).
 *
 * Returns `{ commitment: number[] | null, totalStake }` for a slot. For a
 * finalized slot `commitment` has settled (null — no longer in the recent
 * commitment array) and `totalStake` is the current epoch's total active stake,
 * stable within the challenge window. We project `{ totalStake, commitmentNull }`
 * — byte-equal across providers. `totalStake` is a u64 (> 2^53), so JSON parses
 * it with float precision; we bucket it to the nearest 1e3 lamports to absorb
 * that noise while staying far below any real divergence.
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
import { pickFinalizedSlot } from "./probe.js";

export const BUCKETS = ["recent_finalized", "archival"] as const;
export type GetBlockCommitmentBucket = (typeof BUCKETS)[number];

export interface GetBlockCommitmentParams {
  slot: number;
}

interface GetBlockCommitmentResponse {
  commitment: number[] | null;
  totalStake?: number;
}

function projectImpl(response: GetBlockCommitmentResponse): CanonicalProjection {
  const total = typeof response?.totalStake === "number" ? response.totalStake : null;
  // Round to the nearest 1e3 lamports: above float64 noise on a ~4e17 u64,
  // far below any genuine cross-provider stake difference.
  const totalStakeBucketed = total === null ? null : Math.round(total / 1e3) * 1e3;
  const shape = {
    totalStake: totalStakeBucketed,
    commitmentNull: response?.commitment == null,
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveBlockCommitmentChallenge(
  ctx: ChallengeContext,
  bucket: GetBlockCommitmentBucket,
): Promise<{ params: GetBlockCommitmentParams; bucket: GetBlockCommitmentBucket } | null> {
  const slot = pickFinalizedSlot(ctx, bucket);
  if (slot === null) return null;
  return { params: { slot: Number(slot) }, bucket };
}

export const handlers: MethodHandlers<GetBlockCommitmentParams, GetBlockCommitmentResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveBlockCommitmentChallenge(ctx, ctx.bucket as GetBlockCommitmentBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
