/**
 * getBlockTime — Archetype A (deterministic byte-equal).
 *
 * Returns the estimated Unix production time of a block at a given slot. For a
 * finalized slot the value is fixed, so every provider must return the same
 * integer. Derivation probes the utility endpoint to ensure the picked slot was
 * actually produced (skipped slots error / return null) before committing it.
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
export type GetBlockTimeBucket = (typeof BUCKETS)[number];

export interface GetBlockTimeParams {
  slot: number;
}

type GetBlockTimeResponse = number | null;

function projectImpl(response: GetBlockTimeResponse): CanonicalProjection {
  const shape = { blockTime: typeof response === "number" ? response : null };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveBlockTimeChallenge(
  ctx: ChallengeContext,
  bucket: GetBlockTimeBucket,
): Promise<{ params: GetBlockTimeParams; bucket: GetBlockTimeBucket } | null> {
  const slot = pickFinalizedSlot(ctx, bucket);
  if (slot === null) return null;
  // Confirm the slot was produced (not skipped) so the challenge has a real,
  // deterministic answer; otherwise retry next tick.
  try {
    const t = await ctx.utility.call<number | null>("getBlockTime", [Number(slot)]);
    if (typeof t !== "number") return null;
  } catch {
    return null;
  }
  return { params: { slot: Number(slot) }, bucket };
}

export const handlers: MethodHandlers<GetBlockTimeParams, GetBlockTimeResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveBlockTimeChallenge(ctx, ctx.bucket as GetBlockTimeBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
