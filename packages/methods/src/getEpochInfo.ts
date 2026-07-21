/**
 * getEpochInfo — Archetype B1 (tip-slot freshness, epoch-gated).
 *
 * Returns `{ epoch, slotIndex, absoluteSlot, blockHeight, transactionCount }`.
 * `absoluteSlot` advances with the tip (so byte-equal is impossible), but
 * `epoch` is a discrete value every provider must agree on. So we CANNOT reuse
 * getSlot's plain slot-tolerance predicate: two providers within ±4 slots that
 * straddle an epoch rollover would wrongly match. The dedicated predicates here
 * require `epoch` equality AND `absoluteSlot` within the consensus tolerance.
 * Wired in record.ts.
 *
 * Correctness = a freshness verdict on `absoluteSlot` (it ≈ the tip) plus a gate
 * that `epoch` is present.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { freshnessVerdict, slotFromShape, SLOT_TOLERANCE } from "./freshness.js";

export const BUCKETS = ["processed", "confirmed", "finalized"] as const;
export type GetEpochInfoBucket = (typeof BUCKETS)[number];

export interface GetEpochInfoParams {
  options: { commitment: GetEpochInfoBucket };
}

interface GetEpochInfoResponse {
  epoch?: number;
  slotIndex?: number;
  absoluteSlot?: number;
  blockHeight?: number;
  transactionCount?: number;
}

function epochFromShape(shape: unknown): number | null {
  if (!shape || typeof shape !== "object") return null;
  const e = (shape as { epoch?: unknown }).epoch;
  return typeof e === "number" ? e : null;
}

function projectImpl(response: GetEpochInfoResponse): CanonicalProjection {
  const epoch = typeof response?.epoch === "number" ? response.epoch : null;
  const slot = typeof response?.absoluteSlot === "number" ? response.absoluteSlot : null;
  const shape = { epoch, slot };
  // Hash {epoch} as a diagnostic; matching is the epoch+slot-tolerance predicate.
  return { hash: hashProjection(canonicalize({ epoch })), shape };
}

function epochSlotMatch(a: CanonicalProjection, b: CanonicalProjection, tol: number): boolean {
  const ea = epochFromShape(a.shape);
  const eb = epochFromShape(b.shape);
  if (ea === null || eb === null || ea !== eb) return false;
  const sa = slotFromShape(a.shape);
  const sb = slotFromShape(b.shape);
  if (sa === null || sb === null) return false;
  return Math.abs(sa - sb) <= tol;
}

/** Consensus match: same epoch AND absoluteSlot within the tight tolerance. */
export function epochInfoProjectionsMatch(a: CanonicalProjection, b: CanonicalProjection): boolean {
  return epochSlotMatch(a, b, SLOT_TOLERANCE);
}

export const handlers: MethodHandlers<GetEpochInfoParams, GetEpochInfoResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { options: { commitment: ctx.bucket as GetEpochInfoBucket } }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, _reference, _providerTipSlot, referenceTipSlot): Correctness {
    if (epochFromShape(projection.shape) === null) return "incorrect";
    return freshnessVerdict(projection, referenceTipSlot);
  },
};
