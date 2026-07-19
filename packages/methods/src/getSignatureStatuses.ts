/**
 * getSignatureStatuses — Archetype A (deterministic byte-equal).
 *
 * Returns per-signature status `{ slot, confirmations, err, confirmationStatus }`.
 * The tx-confirmation hot path. For RECENT, unconfirmed sigs the status churns
 * (confirmations climb, confirmationStatus advances), so we pin to FINALIZED
 * signatures pulled from a settled block: their `{ slot, err }` is immutable and
 * identical across providers. We drop `confirmations` (always null once rooted)
 * and `confirmationStatus` (cosmetically "finalized" everywhere) and keep the
 * load-bearing `{ slot, err }` per sig, in input order.
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

export const BUCKETS = ["finalized"] as const;
export type GetSignatureStatusesBucket = (typeof BUCKETS)[number];

/** Number of signatures per challenge. */
const N = 5;

export interface GetSignatureStatusesParams {
  signatures: string[];
  options: { searchTransactionHistory: true };
}

interface SignatureStatus {
  slot?: number;
  err?: unknown;
}
interface GetSignatureStatusesResponse {
  context?: { slot?: number };
  value: Array<SignatureStatus | null>;
}
interface SignaturesProbe {
  signatures?: string[];
}

const OPTIONS: GetSignatureStatusesParams["options"] = { searchTransactionHistory: true };

function projectImpl(response: GetSignatureStatusesResponse): CanonicalProjection {
  const statuses = Array.isArray(response?.value)
    ? response.value.map((s) =>
        s === null ? null : { slot: typeof s.slot === "number" ? s.slot : null, err: s.err ?? null },
      )
    : [];
  const shape = { statuses };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveSignatureStatusesChallenge(
  ctx: ChallengeContext,
  bucket: GetSignatureStatusesBucket,
): Promise<{ params: GetSignatureStatusesParams; bucket: GetSignatureStatusesBucket } | null> {
  const slot = pickFinalizedSlot(ctx, "recent_finalized");
  if (slot === null) return null;
  let block: SignaturesProbe;
  try {
    block = await ctx.utility.call<SignaturesProbe>("getBlock", [
      Number(slot),
      {
        transactionDetails: "signatures",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
        rewards: false,
      },
    ]);
  } catch {
    return null;
  }
  const signatures = (block.signatures ?? []).filter((s) => typeof s === "string").slice(0, N);
  if (signatures.length === 0) return null;
  return { params: { signatures, options: OPTIONS }, bucket };
}

export const handlers: MethodHandlers<GetSignatureStatusesParams, GetSignatureStatusesResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSignatureStatusesChallenge(ctx, ctx.bucket as GetSignatureStatusesBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
