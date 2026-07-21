/**
 * getLeaderSchedule — Archetype A (deterministic byte-equal).
 *
 * Returns the leader schedule (validator identity → leader slot indices) for
 * the epoch containing the requested slot. The schedule is fixed at the start
 * of each epoch, so providers resolving the SAME epoch return identical maps.
 * We pin a concrete recent finalized slot (rather than null = "current epoch")
 * so every provider resolves the same epoch even near a boundary.
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

export const BUCKETS = ["current_epoch"] as const;
export type GetLeaderScheduleBucket = (typeof BUCKETS)[number];

export interface GetLeaderScheduleParams {
  slot: number;
  options: Record<string, never>;
}

type GetLeaderScheduleResponse = Record<string, number[]> | null;

function projectImpl(response: GetLeaderScheduleResponse): CanonicalProjection {
  // canonicalize sorts object keys recursively; the slot-index arrays are
  // already deterministic per validator. A null response (epoch out of range)
  // hashes distinctly so a provider missing the schedule dissents.
  const shape = { schedule: response ?? null };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveLeaderScheduleChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetLeaderScheduleParams; bucket: GetLeaderScheduleBucket } | null> {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip <= 1000n) return null;
  // A finalized slot safely inside the current epoch for all providers.
  const slot = Number(tip - 1000n);
  return { params: { slot, options: {} }, bucket: "current_epoch" };
}

export const handlers: MethodHandlers<GetLeaderScheduleParams, GetLeaderScheduleResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveLeaderScheduleChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
