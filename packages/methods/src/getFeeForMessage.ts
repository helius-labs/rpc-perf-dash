/**
 * getFeeForMessage — HYBRID value method (like getBalance).
 *
 * Returns `{ context:{slot}, value: <fee lamports> | null }` for a serialized
 * message. We build a deterministic Memo message with a fresh blockhash (reusing
 * the simtx builder); the fee is a network constant (5000 lamports/signature),
 * so when the panel agrees on the value it's verified byte-equal. The catch is
 * blockhash expiry: a provider whose tip has passed the message's blockhash
 * returns `null`. So:
 *   - project hashes `{ fee }` (fee = the number, or `null` when expired). All
 *     providers that agree on a value (including all-`null` when expired
 *     panel-wide) group together for the value-majority path.
 *   - when the panel splits between the numeric fee and `null` (expiry timing),
 *     no value-majority forms and `livenessFallback` decides on freshness — the
 *     `null` providers are simply behind, not wrong.
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
import { contextSlot, freshnessVerdict, valueDivergenceVerdict } from "./freshness.js";
import { recentBlock, collectSigners } from "./probe.js";
import { buildMemoMessageBase64 } from "./simtx.js";

export const BUCKETS = ["memo"] as const;
export type GetFeeForMessageBucket = (typeof BUCKETS)[number];

const MEMO_TEXT = "rpcbench";

export interface GetFeeForMessageParams {
  message: string;
  options: { commitment: "confirmed" };
}

interface GetFeeForMessageResponse {
  context?: { slot?: number };
  value: number | null;
}

const OPTIONS: GetFeeForMessageParams["options"] = { commitment: "confirmed" };

function projectImpl(response: GetFeeForMessageResponse): CanonicalProjection {
  const slot = contextSlot(response);
  const fee = typeof response?.value === "number" ? response.value : null;
  const hash = hashProjection(canonicalize({ fee }));
  return { hash, shape: { slot, fee } };
}

export async function deriveFeeForMessageChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetFeeForMessageParams; bucket: GetFeeForMessageBucket } | null> {
  const block = await recentBlock(ctx);
  if (!block) return null;
  const feePayer = collectSigners(block)[0];
  if (!feePayer) return null;
  let blockhash: string;
  try {
    const res = await ctx.utility.call<{ value?: { blockhash?: string } }>("getLatestBlockhash", [
      { commitment: "finalized" },
    ]);
    if (typeof res?.value?.blockhash !== "string") return null;
    blockhash = res.value.blockhash;
  } catch {
    return null;
  }
  let message: string;
  try {
    message = buildMemoMessageBase64(feePayer, blockhash, MEMO_TEXT);
  } catch {
    return null;
  }
  return { params: { message, options: OPTIONS }, bucket: "memo" };
}

export const handlers: MethodHandlers<GetFeeForMessageParams, GetFeeForMessageResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveFeeForMessageChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (byteEqualHash(projection, reference)) return "correct";
    return valueDivergenceVerdict(projection, reference, providerTipSlot, referenceTipSlot);
  },
  livenessFallback(projection, referenceTipSlot): Correctness {
    return freshnessVerdict(projection, referenceTipSlot);
  },
};
