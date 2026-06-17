/**
 * getMaxRetransmitSlot — Archetype B1 (tip-slot freshness).
 *
 * Returns the max slot seen from the retransmit stage — a node-local slot that
 * tracks the tip. Byte-equal is impossible (every node answers its own tip), so
 * it is scored exactly like getSlot: consensus on slot tolerance (±4), wide
 * auditor tolerance (±150), correctness = freshness verdict. Both predicates
 * are wired in record.ts to getSlot's `slotProjectionsMatch{,Auditor}`.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { freshnessVerdict, slotFromShape } from "./freshness.js";

export const BUCKETS = ["default"] as const;
export type GetMaxRetransmitSlotBucket = (typeof BUCKETS)[number];

export type GetMaxRetransmitSlotParams = Record<string, never>;

type GetMaxRetransmitSlotResponse = number;

function projectImpl(response: GetMaxRetransmitSlotResponse): CanonicalProjection {
  const slot = typeof response === "number" ? response : null;
  const shape = { slot };
  // Hash {slot} as a diagnostic; matching is slot-tolerance (mirrors getSlot).
  return { hash: hashProjection(canonicalize({ slot })), shape };
}

export const handlers: MethodHandlers<GetMaxRetransmitSlotParams, GetMaxRetransmitSlotResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, _reference, _providerTipSlot, referenceTipSlot): Correctness {
    if (slotFromShape(projection.shape) === null) return "incorrect";
    return freshnessVerdict(projection, referenceTipSlot);
  },
};
