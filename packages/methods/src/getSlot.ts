/**
 * getSlot method handlers.
 *
 * getSlot returns a single, constantly-advancing integer — the network's
 * current slot height at the requested commitment. Byte-equal cross-provider
 * consensus is impossible by construction: every node answers with its own tip
 * at the moment it's queried, and those tips differ by a few slots even among
 * perfectly healthy providers. So getSlot is scored through the same
 * SIMILARITY consensus path as getSignaturesForAddress (see
 * packages/shared/src/consensus.ts), with a tolerance window instead of a
 * hash equality check.
 *
 * What getSlot actually measures: LATENCY and RELIABILITY. Its correctness (C)
 * axis is a liveness check by construction — because the per-provider freshness
 * piggyback (fanout.ts) and this method call are issued near-simultaneously
 * from the same provider, the returned slot ≈ the provider's tip essentially
 * always, so C sits ~100%. That's harmless: the leaderboard scores one method
 * at a time, so getSlot's C never contaminates another method's board.
 *
 * Buckets: commitment level — processed | confirmed | finalized.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";

export const BUCKETS = ["processed", "confirmed", "finalized"] as const;
export type GetSlotBucket = (typeof BUCKETS)[number];

export interface GetSlotParams {
  options: { commitment: GetSlotBucket };
}

/** getSlot returns a bare integer (the slot height). */
type GetSlotResponse = number;

/**
 * Two slots "agree" if they're within SLOT_TOLERANCE of each other. Used for
 * CONSENSUS voting among benchmarked providers, who are called
 * near-simultaneously, so a tight window is right — 4 slots is ~1.6s of chain
 * progress (~2.5 slots/s), comfortably above honest inter-provider tip jitter
 * but tight enough that a genuinely lagging provider still dissents.
 *
 * freshness.ts declares its own SLOT_TOLERANCE with the same value for the
 * context-wrapped methods. Separate knobs on purpose (this one also feeds
 * getSlot's answer-equivalence check) — retune them together unless you mean
 * to split.
 */
export const SLOT_TOLERANCE = 4;

function slotFromShape(shape: unknown): number | null {
  if (!shape || typeof shape !== "object") return null;
  const s = (shape as { slot?: unknown }).slot;
  return typeof s === "number" ? s : null;
}

function projectImpl(response: GetSlotResponse): CanonicalProjection {
  const slot = typeof response === "number" ? response : 0;
  const shape = { slot };
  const json = canonicalize(shape);
  return { hash: hashProjection(json), shape };
}

/**
 * Similarity match for CONSENSUS voting among the benchmarked panel:
 * |a − b| ≤ SLOT_TOLERANCE. Providers are queried in parallel, so a tight
 * window is correct.
 */
export function slotProjectionsMatch(
  a: CanonicalProjection,
  b: CanonicalProjection,
): boolean {
  const sa = slotFromShape(a.shape);
  const sb = slotFromShape(b.shape);
  if (sa === null || sb === null) return false;
  return Math.abs(sa - sb) <= SLOT_TOLERANCE;
}

export async function deriveSlotChallenge(
  ctx: ChallengeContext,
  bucket: GetSlotBucket,
): Promise<{ params: GetSlotParams; bucket: GetSlotBucket } | null> {
  // No preflight needed — getSlot takes only a commitment level.
  return { params: { options: { commitment: bucket } }, bucket };
}

export const handlers: MethodHandlers<GetSlotParams, GetSlotResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSlotChallenge(ctx, ctx.bucket as GetSlotBucket);
  },
  project: projectImpl,
  classify(projection, _reference, _providerTipSlot, referenceTipSlot): Correctness {
    // The worker runs seconds after the reference is captured, so its slot is
    // NEWER than the reference, not equal — absolute equality is meaningless.
    // Score on freshness against the method's OWN returned slot (not
    // providerTipSlot, which falls back to reference_tip_slot when the
    // piggyback fails — see record.ts — and would silently compare against a
    // stale-time reference). A provider that isn't behind the reference tip is
    // correct; one that lags by more than the tolerance is stale.
    const returned = slotFromShape(projection.shape);
    if (returned === null) return "incorrect";
    // referenceTipSlot === 0n when the tip-capture piggyback failed
    // (fanout.ts); the check then degenerates to `returned >= -TOLERANCE` →
    // always correct. That's a safe fail-open (never spurious incorrect),
    // consistent with C being a liveness check by construction.
    if (BigInt(returned) >= referenceTipSlot - BigInt(SLOT_TOLERANCE)) return "correct";
    return "stale";
  },
};
