/**
 * getSlotLeader — well-formedness-only (availability/latency probe).
 *
 * Returns the leader identity pubkey for the CURRENT slot. It takes only a
 * commitment (no slot param), so it is inherently tip-dependent: providers sit
 * at slightly different tips and the leader rotates every 4 slots, so they
 * rarely return the same pubkey at the same instant. Byte-equal cross-provider
 * agreement in real time is impossible — same class as getSlot: byte-equal
 * scoring would give a misleading low correctness that measures tip jitter, not
 * provider correctness.
 *
 * So getSlotLeader is scored like getIdentity: project a BOOLEAN well-formedness
 * verdict (`{ wellFormed }` — the leader is a base58-32 pubkey). Serving
 * providers all hash `true` → byte-equal consensus → correct (C ≈ 100% by
 * construction); a malformed-but-200 body dissents → incorrect. This measures
 * availability + well-formedness, NOT cross-provider leader agreement.
 *
 * For the REAL cross-provider leader-schedule correctness signal, see
 * getSlotLeaders (plural), which pins a finalized slot range and is byte-equal.
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
import { isBase58_32 } from "./wellformed.js";

export const BUCKETS = ["processed", "confirmed", "finalized"] as const;
export type GetSlotLeaderBucket = (typeof BUCKETS)[number];

export interface GetSlotLeaderParams {
  options: { commitment: GetSlotLeaderBucket };
}

type GetSlotLeaderResponse = string;

function projectImpl(response: GetSlotLeaderResponse): CanonicalProjection {
  const shape = { wellFormed: isBase58_32(response) };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetSlotLeaderParams, GetSlotLeaderResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { options: { commitment: ctx.bucket as GetSlotLeaderBucket } }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
