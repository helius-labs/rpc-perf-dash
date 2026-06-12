/**
 * getSupply method handlers — TIME-ADVANCING scalar (freshness + sanity gate).
 *
 * ⚠️ DISABLED — registered but NOT emitted by the generator (see
 * apps/generator/src/index.ts `allMethodBucketCombos` and docs/methodology.md).
 * Live measurement showed getSupply can't reach the 3-voter consensus minimum
 * on the current panel: only triton (~6s) and alchemy (~9s) compute it live and
 * agree, quicknode serves a stale cache, and helius hangs >30s — so no
 * request timeout rescues it. The handler is kept here (dormant) so any
 * in-flight straggler challenge resolves safely instead of crashing a worker on
 * an unknown-method lookup, and so re-enabling is a one-line change.
 *
 * Returns `{ context:{slot}, value:{ total, circulating, nonCirculating,
 * nonCirculatingAccounts } }`. `total` inflates ~constantly (~0.4 SOL/slot) and
 * circulating/nonCirculating drift, so there is NO way to byte-compare the
 * figures across providers/time — exact supply correctness is impossible.
 *
 * So getSupply is scored like getSlot: consensus matches on the returned
 * `context.slot` (tight tolerance; wide auditor tolerance — both wired in
 * record.ts via the shared freshness predicates), and correctness is a
 * freshness/liveness verdict. On TOP of freshness, `classify` applies a cheap
 * internal-consistency gate (`circulating + nonCirculating ≈ total`, all finite
 * & non-negative) to catch a genuinely broken provider. NOTE: this is NOT a
 * cross-provider check that the supply figure is *correct* — see the
 * methodology caveat. `excludeNonCirculatingAccountsList: true` keeps the
 * response small (the large accounts list is irrelevant to the projection).
 *
 * Supply figures are u64 lamports (~5.8e17), above Number.MAX_SAFE_INTEGER, so
 * JSON parses them with float precision loss; the consistency gate uses a
 * relative tolerance well above float noise but far below any real error.
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
