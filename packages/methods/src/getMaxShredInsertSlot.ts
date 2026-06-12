/**
 * getMaxShredInsertSlot — Archetype B1 (tip-slot freshness).
 *
 * Returns the max slot seen from the shred-insert stage — a node-local slot
 * tracking the tip. Scored like getSlot/getMaxRetransmitSlot: slot-tolerance
 * consensus (±4) / wide auditor (±150) via getSlot's predicates (wired in
 * record.ts), correctness = freshness verdict.
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
export type GetMaxShredInsertSlotBucket = (typeof BUCKETS)[number];

export interface GetMaxShredInsertSlotParams {}

type GetMaxShredInsertSlotResponse = number;

function projectImpl(response: GetMaxShredInsertSlotResponse): CanonicalProjection {
  const slot = typeof response === "number" ? response : null;
  const shape = { slot };
  return { hash: hashProjection(canonicalize({ slot })), shape };
}

export const handlers: MethodHandlers<GetMaxShredInsertSlotParams, GetMaxShredInsertSlotResponse> = {
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
