/**
 * getEpochSchedule — Archetype A (deterministic byte-equal).
 *
 * Returns the genesis-config epoch schedule (slotsPerEpoch,
 * leaderScheduleSlotOffset, warmup, firstNormalEpoch, firstNormalSlot) — a
 * network constant. No input. Byte-equal consensus + auditor.
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
export type GetEpochScheduleBucket = (typeof BUCKETS)[number];

export interface GetEpochScheduleParams {}

interface GetEpochScheduleResponse {
  slotsPerEpoch?: number;
  leaderScheduleSlotOffset?: number;
  warmup?: boolean;
  firstNormalEpoch?: number;
  firstNormalSlot?: number;
}

function projectImpl(response: GetEpochScheduleResponse): CanonicalProjection {
  const shape = {
    slotsPerEpoch: response?.slotsPerEpoch ?? null,
    leaderScheduleSlotOffset: response?.leaderScheduleSlotOffset ?? null,
    warmup: response?.warmup ?? null,
    firstNormalEpoch: response?.firstNormalEpoch ?? null,
    firstNormalSlot: response?.firstNormalSlot ?? null,
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetEpochScheduleParams, GetEpochScheduleResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
