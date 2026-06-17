/**
 * getSupply method handlers — TIME-ADVANCING scalar (freshness + sanity gate).
 *
 * ⚠️ DISABLED — registered but NOT emitted by the generator. Live measurement
 * showed getSupply can't reach the 3-voter consensus minimum on the current
 * panel (providers variously compute it live, serve stale caches, or hang past
 * the timeout). The handler is kept here dormant so any in-flight straggler
 * challenge resolves instead of crashing a worker, and re-enabling is one line.
 *
 * Supply figures advance every slot and can't be byte-compared across
 * providers, so — like getSlot — it's scored on the returned `context.slot`
 * via the shared freshness predicates (wired in record.ts), with `classify`
 * adding a cheap internal-consistency gate (circulating + nonCirculating ≈
 * total) to catch a broken provider. That gate is NOT a cross-provider check
 * that the figure is correct. Note: u64 lamports exceed Number.MAX_SAFE_INTEGER
 * so JSON loses precision; the gate's tolerance sits above that float noise.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { contextSlot, freshnessVerdict } from "./freshness.js";

export const BUCKETS = ["finalized"] as const;
export type GetSupplyBucket = (typeof BUCKETS)[number];

export interface GetSupplyParams {
  options: { commitment: GetSupplyBucket; excludeNonCirculatingAccountsList: true };
}

interface SupplyValue {
  total?: number;
  circulating?: number;
  nonCirculating?: number;
}
interface GetSupplyResponse {
  context?: { slot?: number };
  value: SupplyValue | null;
}

function projectImpl(response: GetSupplyResponse): CanonicalProjection {
  const slot = contextSlot(response);
  const v = response?.value ?? null;
  // Carry the figures in shape for the consistency gate; the slot drives
  // matching. Hash only {slot} — matching is slot-tolerance, so the hash is a
  // diagnostic, not the equivalence key (mirrors getSlot).
  const shape = {
    slot,
    total: typeof v?.total === "number" ? v.total : null,
    circulating: typeof v?.circulating === "number" ? v.circulating : null,
    nonCirculating: typeof v?.nonCirculating === "number" ? v.nonCirculating : null,
  };
  return { hash: hashProjection(canonicalize({ slot })), shape };
}

function consistent(shape: {
  total: number | null;
  circulating: number | null;
  nonCirculating: number | null;
}): boolean {
  const { total, circulating, nonCirculating } = shape;
  if (total === null || circulating === null || nonCirculating === null) return false;
  if (![total, circulating, nonCirculating].every((n) => Number.isFinite(n) && n >= 0)) return false;
  const diff = Math.abs(circulating + nonCirculating - total);
  // Relative tolerance ~1e-9 (≫ float64 noise of ~1e-15, ≪ any real error),
  // with an absolute floor for tiny totals.
  return diff <= Math.max(1e6, total * 1e-9);
}

export async function deriveSupplyChallenge(
  ctx: ChallengeContext,
  bucket: GetSupplyBucket,
): Promise<{ params: GetSupplyParams; bucket: GetSupplyBucket } | null> {
  // No preflight — getSupply takes only options.
  return {
    params: { options: { commitment: bucket, excludeNonCirculatingAccountsList: true } },
    bucket,
  };
}

export const handlers: MethodHandlers<GetSupplyParams, GetSupplyResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSupplyChallenge(ctx, ctx.bucket as GetSupplyBucket);
  },
  project: projectImpl,
  classify(projection, _reference, _providerTipSlot, referenceTipSlot): Correctness {
    const shape = projection.shape as {
      total: number | null;
      circulating: number | null;
      nonCirculating: number | null;
    };
    if (!consistent(shape)) return "incorrect";
    return freshnessVerdict(projection, referenceTipSlot);
  },
};
