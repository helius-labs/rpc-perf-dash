/**
 * getLatestBlockhash method handlers — TIME-ADVANCING scalar (freshness + gate).
 *
 * Returns `{ context:{slot}, value:{ blockhash, lastValidBlockHeight } }`. The
 * blockhash is unique per slot and advances every ~400ms, so two providers at
 * different tips never share a blockhash — byte-comparing the value is
 * impossible by construction.
 *
 * So getLatestBlockhash is scored like getSlot: consensus matches on the
 * returned `context.slot` (tight tolerance; wide auditor tolerance — wired in
 * record.ts via the shared freshness predicates), and correctness is a freshness
 * verdict. On TOP of freshness, `classify` applies a well-formedness gate (the
 * blockhash is a base58 32-byte string; lastValidBlockHeight is finite & > 0) to
 * catch a provider returning garbage. NOTE: there is NO cross-provider check
 * that the blockhash VALUE is correct — see the methodology caveat.
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
import { BASE58_32 } from "./wellformed.js";

export const BUCKETS = ["finalized", "confirmed"] as const;
export type GetLatestBlockhashBucket = (typeof BUCKETS)[number];

export interface GetLatestBlockhashParams {
  options: { commitment: GetLatestBlockhashBucket };
}

interface BlockhashValue {
  blockhash?: string;
  lastValidBlockHeight?: number;
}
interface GetLatestBlockhashResponse {
  context?: { slot?: number };
  value: BlockhashValue | null;
}

function projectImpl(response: GetLatestBlockhashResponse): CanonicalProjection {
  const slot = contextSlot(response);
  const v = response?.value ?? null;
  const shape = {
    slot,
    blockhash: typeof v?.blockhash === "string" ? v.blockhash : null,
    lastValidBlockHeight: typeof v?.lastValidBlockHeight === "number" ? v.lastValidBlockHeight : null,
  };
  // Match on slot tolerance; hash {slot} as a diagnostic (mirrors getSlot).
  return { hash: hashProjection(canonicalize({ slot })), shape };
}

function wellFormed(shape: { blockhash: string | null; lastValidBlockHeight: number | null }): boolean {
  if (!shape.blockhash || !BASE58_32.test(shape.blockhash)) return false;
  if (shape.lastValidBlockHeight === null) return false;
  return Number.isFinite(shape.lastValidBlockHeight) && shape.lastValidBlockHeight > 0;
}

export async function deriveLatestBlockhashChallenge(
  ctx: ChallengeContext,
  bucket: GetLatestBlockhashBucket,
): Promise<{ params: GetLatestBlockhashParams; bucket: GetLatestBlockhashBucket } | null> {
  // No preflight — getLatestBlockhash takes only a commitment.
  return { params: { options: { commitment: bucket } }, bucket };
}

export const handlers: MethodHandlers<GetLatestBlockhashParams, GetLatestBlockhashResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveLatestBlockhashChallenge(ctx, ctx.bucket as GetLatestBlockhashBucket);
  },
  project: projectImpl,
  classify(projection, _reference, _providerTipSlot, referenceTipSlot): Correctness {
    const shape = projection.shape as { blockhash: string | null; lastValidBlockHeight: number | null };
    if (!wellFormed(shape)) return "incorrect";
    return freshnessVerdict(projection, referenceTipSlot);
  },
};
