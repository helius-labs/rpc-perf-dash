/**
 * simulateTransaction — Archetype F (simulation, byte-equal).
 *
 * Simulates a single Memo transaction. We build it with a funded fee payer (a
 * signer pulled from a recent block) and a fresh blockhash, and call with
 * `sigVerify:false, replaceRecentBlockhash:true` so no real signature is needed.
 * A Memo costs a deterministic number of compute units and returns `err:null`,
 * so `{ err, unitsConsumed }` is identical across providers → byte-equal
 * consensus + auditor.
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
import { recentBlock, collectSigners } from "./probe.js";
import { buildMemoTransactionBase64 } from "./simtx.js";

export const BUCKETS = ["memo"] as const;
export type SimulateTransactionBucket = (typeof BUCKETS)[number];

const MEMO_TEXT = "rpcbench";

export interface SimulateTransactionParams {
  tx: string;
  options: {
    sigVerify: false;
    replaceRecentBlockhash: true;
    encoding: "base64";
    commitment: "confirmed";
  };
}

interface SimulateTransactionResponse {
  context?: { slot?: number };
  value?: {
    err?: unknown;
    unitsConsumed?: number;
  } | null;
}

const OPTIONS: SimulateTransactionParams["options"] = {
  sigVerify: false,
  replaceRecentBlockhash: true,
  encoding: "base64",
  commitment: "confirmed",
};

function projectImpl(response: SimulateTransactionResponse): CanonicalProjection {
  const v = response?.value ?? null;
  const shape = {
    err: v?.err ?? null,
    unitsConsumed: typeof v?.unitsConsumed === "number" ? v.unitsConsumed : null,
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveSimulateTransactionChallenge(
  ctx: ChallengeContext,
): Promise<{ params: SimulateTransactionParams; bucket: SimulateTransactionBucket } | null> {
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
  let tx: string;
  try {
    tx = buildMemoTransactionBase64(feePayer, blockhash, MEMO_TEXT);
  } catch {
    return null;
  }
  return { params: { tx, options: OPTIONS }, bucket: "memo" };
}

export const handlers: MethodHandlers<SimulateTransactionParams, SimulateTransactionResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSimulateTransactionChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
