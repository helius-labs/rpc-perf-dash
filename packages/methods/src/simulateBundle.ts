/**
 * simulateBundle — Archetype F (simulation, byte-equal). Jito extension.
 *
 * NOT served by QuickNode (declared unsupported in providers.ts) → 3-voter
 * panel (Helius, Triton, Alchemy). Simulates a one-transaction bundle (the same
 * Memo tx as simulateTransaction). simulateBundle's config flags vary by
 * provider; we request `skipSigVerify` + `replaceRecentBlockhash` and build the
 * tx with a fresh blockhash + funded fee payer so it validates either way.
 * Project `{ summary, perTx:[{ err, unitsConsumed }] }` → byte-equal.
 *
 * ⚠️ The exact config-flag names / blockhash handling are provider-sensitive
 * and MUST be validated live against the 3 supporting providers before relying
 * on the correctness number.
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
export type SimulateBundleBucket = (typeof BUCKETS)[number];

const MEMO_TEXT = "rpcbench";

export interface SimulateBundleParams {
  bundle: { encodedTransactions: string[] };
  options: {
    // Jito requires per-tx account-snapshot configs (one entry per tx; null =
    // don't snapshot). Without them the RPC returns "Invalid params: missing
    // field preExecutionAccountsConfigs". skipSigVerify lets the zero signature
    // pass; replaceRecentBlockhash is belt-and-suspenders alongside the fresh
    // blockhash we splice in.
    preExecutionAccountsConfigs: null[];
    postExecutionAccountsConfigs: null[];
    skipSigVerify: true;
    replaceRecentBlockhash: true;
  };
}

interface BundleTxResult {
  err?: unknown;
  unitsConsumed?: number;
}
interface SimulateBundleResponse {
  context?: { slot?: number };
  value?: {
    summary?: unknown;
    transactionResults?: BundleTxResult[];
  } | null;
}

// One null per transaction in the bundle (we send exactly one).
const OPTIONS: SimulateBundleParams["options"] = {
  preExecutionAccountsConfigs: [null],
  postExecutionAccountsConfigs: [null],
  skipSigVerify: true,
  replaceRecentBlockhash: true,
};

function projectImpl(response: SimulateBundleResponse): CanonicalProjection {
  const v = response?.value ?? null;
  const perTx = (v?.transactionResults ?? []).map((r) => ({
    err: r?.err ?? null,
    unitsConsumed: typeof r?.unitsConsumed === "number" ? r.unitsConsumed : null,
  }));
  const shape = { summary: v?.summary ?? null, perTx };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveSimulateBundleChallenge(
  ctx: ChallengeContext,
): Promise<{ params: SimulateBundleParams; bucket: SimulateBundleBucket } | null> {
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
  return { params: { bundle: { encodedTransactions: [tx] }, options: OPTIONS }, bucket: "memo" };
}

export const handlers: MethodHandlers<SimulateBundleParams, SimulateBundleResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSimulateBundleChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
