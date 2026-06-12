/**
 * getBlockProduction — Archetype A (deterministic byte-equal).
 *
 * Returns per-validator `[leaderSlots, blocksProduced]` over a slot range. Over
 * a COMPLETED (finalized) range the counts are immutable, so providers agree
 * exactly. We pin the range to end well behind the tip and span a fixed window.
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

export const BUCKETS = ["recent_range"] as const;
export type GetBlockProductionBucket = (typeof BUCKETS)[number];

/** Range span (slots). End sits tip−SETBACK so the whole range is finalized. */
const SPAN = 1000;
const SETBACK = 200;

export interface GetBlockProductionParams {
  options: { commitment: "finalized"; range: { firstSlot: number; lastSlot: number } };
}

interface GetBlockProductionResponse {
  context?: { slot?: number };
  value?: {
    byIdentity?: Record<string, [number, number]>;
    range?: { firstSlot?: number; lastSlot?: number };
  };
}

function projectImpl(response: GetBlockProductionResponse): CanonicalProjection {
  const v = response?.value;
  const shape = {
    byIdentity: v?.byIdentity ?? null,
    range: {
      firstSlot: v?.range?.firstSlot ?? null,
      lastSlot: v?.range?.lastSlot ?? null,
    },
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveBlockProductionChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetBlockProductionParams; bucket: GetBlockProductionBucket } | null> {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip <= BigInt(SETBACK + SPAN)) return null;
  const lastSlot = Number(tip - BigInt(SETBACK));
  const firstSlot = lastSlot - SPAN;
  return {
    params: { options: { commitment: "finalized", range: { firstSlot, lastSlot } } },
    bucket: "recent_range",
  };
}

export const handlers: MethodHandlers<GetBlockProductionParams, GetBlockProductionResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveBlockProductionChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
