/**
 * getSlotLeaders — Archetype A (deterministic byte-equal).
 *
 * Returns the leader identity pubkeys for a slot range `[startSlot,
 * startSlot+limit)`. Unlike getSlotLeader (current slot, tip-dependent),
 * getSlotLeaders takes an explicit start slot — so pinning it to a recent
 * FINALIZED range makes the answer immutable and identical across providers
 * (the leader schedule for a settled epoch is fixed). This is the real
 * cross-provider leader-schedule correctness signal that getSlotLeader can't
 * provide.
 *
 * RECENT-EPOCH ONLY (no archival bucket): an archival bucket scores ~50%
 * incorrect while recent_finalized is 100%.
 * Agave serves getSlotLeaders from an in-memory leader-schedule cache that only
 * covers recent epochs; for slots many epochs back, providers return divergent
 * or empty results (it is NOT a retained, deterministic artifact like a block).
 * So we only challenge a recent finalized range.
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

export const BUCKETS = ["recent_finalized"] as const;
export type GetSlotLeadersBucket = (typeof BUCKETS)[number];

/** Number of leaders to request (RPC max is 5000; a small window is plenty). */
const LIMIT = 20;

export interface GetSlotLeadersParams {
  startSlot: number;
  limit: number;
}

type GetSlotLeadersResponse = string[];

function projectImpl(response: GetSlotLeadersResponse): CanonicalProjection {
  // Order is significant (leader per slot in sequence) — keep as-is.
  const leaders = Array.isArray(response)
    ? response.map((s) => (typeof s === "string" ? s : ""))
    : [];
  const shape = { leaders };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveSlotLeadersChallenge(
  ctx: ChallengeContext,
  bucket: GetSlotLeadersBucket,
): Promise<{ params: GetSlotLeadersParams; bucket: GetSlotLeadersBucket } | null> {
  const start = pickFinalizedSlot(ctx, bucket);
  if (start === null) return null;
  return { params: { startSlot: Number(start), limit: LIMIT }, bucket };
}

export const handlers: MethodHandlers<GetSlotLeadersParams, GetSlotLeadersResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSlotLeadersChallenge(ctx, ctx.bucket as GetSlotLeadersBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
