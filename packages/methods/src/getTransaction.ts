/**
 * getTransaction method handlers.
 *
 * Bucketing matrix: size × complexity × version × age
 *   size:        small (≤2 instructions)         | large (≥10 instructions)
 *   complexity:  simple (system/token only)      | program_heavy (≥3 distinct programs)
 *   version:     legacy                          | versioned (v0 with ALTs)
 *   age:         recent (<1h)                    | archival (1–2 years back)
 *
 * Projection: same per-tx shape as getBlock — signatures + meta.{err, fee,
 * preBalances, postBalances}, kept together.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { ARCHIVAL_UTILITY_TIMEOUT_MS, withArchivalSlotRetries } from "./probe.js";

const SIZE = ["small", "large"] as const;
const COMPLEXITY = ["simple", "program_heavy"] as const;
const VERSION = ["legacy", "versioned"] as const;
const AGE = ["recent", "archival"] as const;

export const BUCKETS = SIZE.flatMap((s) =>
  COMPLEXITY.flatMap((c) =>
    VERSION.flatMap((v) => AGE.map((a) => `${s}__${c}__${v}__${a}`)),
  ),
);

export interface GetTransactionParams {
  signature: string;
  options: {
    encoding: "json";
    maxSupportedTransactionVersion: 0;
    commitment: "finalized";
  };
}

interface GetTransactionResponse {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { instructions: unknown[] } };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    logMessages?: string[];
  };
  version?: "legacy" | 0;
}

const DROP_KEYS = new Set(["blockTime", "logMessages", "innerInstructions", "loadedAddresses"]);

function projectImpl(response: GetTransactionResponse | null): CanonicalProjection {
  if (response === null) {
    // "not found" — distinct projection so it hashes to a stable value.
    const json = canonicalize({ found: false });
    return { hash: hashProjection(json), shape: { found: false } };
  }
  const shape = {
    found: true,
    slot: response.slot,
    version: response.version ?? "legacy",
    transaction: {
      signatures: [...response.transaction.signatures].sort(),
    },
    meta: {
      err: response.meta.err ?? null,
      fee: response.meta.fee,
      preBalances: response.meta.preBalances,
      postBalances: response.meta.postBalances,
    },
  };
  const json = canonicalize(shape, { dropKeys: DROP_KEYS });
  return { hash: hashProjection(json), shape };
}

interface BlockProbe {
  transactions: Array<{
    transaction: {
      signatures: string[];
      message: { instructions: Array<{ programIdIndex: number }>; accountKeys?: string[] };
    };
    meta: { logMessages?: string[] } | null;
    version?: 0 | "legacy";
  }>;
}

export async function deriveTransactionChallenge(
  ctx: ChallengeContext,
  bucket: string,
): Promise<{ params: GetTransactionParams; bucket: string } | null> {
  const [size, complexity, version, age] = bucket.split("__") as [
    "small" | "large",
    "simple" | "program_heavy",
    "legacy" | "versioned",
    "recent" | "archival",
  ];

  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;

  let block: BlockProbe;
  if (age === "recent") {
    const ageSlot = tip - BigInt(1 + Math.floor(Math.random() * 9000));
    try {
      block = await ctx.utility.call<BlockProbe>("getBlock", [
        Number(ageSlot),
        { encoding: "json", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false },
      ]);
    } catch {
      return null;
    }
  } else {
    // Archival (1–2 years back): skipped slots are common, so a cheap
    // signatures-probe gates each draw; the expensive full fetch (large
    // 2024-era blocks, cold archive read) happens once, with a longer
    // per-call timeout. Both run inside the derive budget.
    const found = await withArchivalSlotRetries(tip, async (s) => {
      const probe = await ctx.utility.call<{ signatures?: string[] }>("getBlock", [
        Number(s),
        { encoding: "json", transactionDetails: "signatures", maxSupportedTransactionVersion: 0, rewards: false },
      ]);
      if (!probe?.signatures?.length) return null;
      return ctx.utility.call<BlockProbe>(
        "getBlock",
        [Number(s), { encoding: "json", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false }],
        { timeoutMs: ARCHIVAL_UTILITY_TIMEOUT_MS },
      );
    });
    if (!found) return null;
    block = found.value;
  }
  if (!block?.transactions?.length) return null;

  for (const tx of block.transactions) {
    const ixCount = tx.transaction.message.instructions.length;
    const txSize = ixCount;
    const txSizeBand: "small" | "large" = txSize <= 2 ? "small" : txSize >= 10 ? "large" : "small";
    if (txSizeBand !== size) continue;

    const programIds = new Set(
      tx.transaction.message.instructions
        .map((ix) => tx.transaction.message.accountKeys?.[ix.programIdIndex] ?? "")
        .filter(Boolean),
    );
    const txComplexity: "simple" | "program_heavy" = programIds.size >= 3 ? "program_heavy" : "simple";
    if (txComplexity !== complexity) continue;

    const txVersion: "legacy" | "versioned" = tx.version === 0 ? "versioned" : "legacy";
    if (txVersion !== version) continue;

    const signature = tx.transaction.signatures[0];
    if (!signature) continue;

    return {
      params: {
        signature,
        options: { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" },
      },
      bucket,
    };
  }
  return null;
}

export const handlers: MethodHandlers<GetTransactionParams, GetTransactionResponse | null> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveTransactionChallenge(ctx, ctx.bucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (!buffersEqual(projection.hash, reference.hash)) {
      // Distinguish incomplete (provider returned `null` while reference returned data)
      // from incorrect.
      const refShape = (reference.shape as { found?: boolean })?.found;
      const provShape = (projection.shape as { found?: boolean })?.found;
      if (refShape === true && provShape === false) return "incomplete";
      return "incorrect";
    }
    if (referenceTipSlot - providerTipSlot > 2n) return "stale";
    return "correct";
  },
};

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
