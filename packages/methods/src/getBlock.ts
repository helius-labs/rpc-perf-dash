/**
 * getBlock method handlers.
 *
 * Buckets: slot age × tx-count.
 *   slot_age:  tip_minus_5 | last_hour | last_24h | archival
 *   tx_count:  high | low
 *
 * Commitment: `confirmed`, not `finalized`. The whole point of the recent
 * bucket is to measure provider freshness — how fast does the provider
 * serve a just-produced block. With `finalized`, the answer is gated by
 * Solana's network-wide finalization timer (~13s median, sometimes 20s+
 * under congestion), which is identical for every provider — measures
 * nothing useful, generates spurious "incorrect" labels whenever the
 * worker hits the slot before finalization. Confirmed blocks propagate
 * in ~2s and providers diverge meaningfully on that timescale, so it
 * cleanly measures provider behavior. Trade-off: confirmed blocks are
 * theoretically reversible (extremely rare on Solana mainnet); we accept
 * that for correctness comparison since every panel voter observes
 * the same confirmed view at sample time.
 *
 * Projection (per plan): blockhash, parentSlot, previousBlockhash, plus
 * per-transaction record kept together (sorted by primary signature):
 *   { signatures: [...], err, fee, preBalances, postBalances }
 *
 * Drop:    blockTime, rewards ordering, meta.logMessages, meta.innerInstructions
 *          ordering.
 */

import {
  canonicalize,
  hashProjection,
  normalizeTxErr,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
  buffersEqual,
} from "@rpcbench/shared";
import { STALE_TIP_LAG_SLOTS } from "./freshness.js";
import { pickArchivalSlot, withArchivalSlotRetries } from "./probe.js";

export const BUCKETS = [
  "tip_minus_5__high",
  "tip_minus_5__low",
  "last_hour__high",
  "last_hour__low",
  "last_24h__high",
  "last_24h__low",
  "archival__high",
  "archival__low",
] as const;
export type GetBlockBucket = (typeof BUCKETS)[number];

export interface GetBlockParams {
  slot: number;
  options: {
    encoding: "json";
    /** Randomized per challenge between "full" and "accounts" — projection
     * is invariant across both. See deriveBlockChallenge. */
    transactionDetails: "full" | "accounts";
    maxSupportedTransactionVersion: 0;
    rewards: false;
    commitment: "confirmed";
  };
}

interface GetBlockResponse {
  blockhash: string;
  parentSlot: number;
  previousBlockhash: string;
  blockTime?: number | null;
  transactions: Array<{
    transaction: { signatures: string[] };
    meta: {
      err: unknown;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      logMessages?: string[];
    } | null;
  }>;
}

const DROP_KEYS = new Set([
  "blockTime",
  "logMessages",
  "innerInstructions",
  "rewards",
  "loadedAddresses",
]);

function projectImpl(response: GetBlockResponse): CanonicalProjection {
  const txRecords = response.transactions
    .map((t) => ({
      signatures: [...t.transaction.signatures].sort(),
      meta: t.meta
        ? {
            err: normalizeTxErr(t.meta.err ?? null),
            fee: t.meta.fee,
            preBalances: t.meta.preBalances,
            postBalances: t.meta.postBalances,
          }
        : null,
    }))
    .sort((a, b) => {
      const sa = a.signatures[0] ?? "";
      const sb = b.signatures[0] ?? "";
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

  const shape = {
    blockhash: response.blockhash,
    parentSlot: response.parentSlot,
    previousBlockhash: response.previousBlockhash,
    transactions: txRecords,
  };
  const json = canonicalize(shape, { dropKeys: DROP_KEYS });
  return { hash: hashProjection(json), shape };
}

/**
 * Derive a getBlock challenge for the given (slot_age, tx_count) bucket.
 *
 * The generator passes a `recentSlots` window; we pick a slot in the requested
 * age band, fetch its tx-count via the utility endpoint, and accept it if it
 * matches the requested tx_count band. The generator retries with another slot
 * if not.
 */
export async function deriveBlockChallenge(
  ctx: ChallengeContext,
  bucket: GetBlockBucket,
): Promise<{ params: GetBlockParams; bucket: GetBlockBucket } | null> {
  const [age, txband] = bucket.split("__") as ["tip_minus_5" | "last_hour" | "last_24h" | "archival", "high" | "low"];
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;

  // Probe block size with utility endpoint to confirm tx-count band.
  // Use confirmed commitment so the probe doesn't race finalization for
  // tip_minus_5 slots — same commitment we'll use in the real challenge.
  const probeBand = async (s: bigint): Promise<bigint | null> => {
    const probe = await ctx.utility.call<{ signatures?: string[] }>("getBlock", [
      Number(s),
      { encoding: "json", transactionDetails: "signatures", maxSupportedTransactionVersion: 0, rewards: false, commitment: "confirmed" },
    ]);
    const isHigh = (probe?.signatures?.length ?? 0) >= 1500;
    if (txband === "high" && !isHigh) return null;
    if (txband === "low" && isHigh) return null;
    return s;
  };

  let slot: bigint;
  if (age === "archival") {
    // Skipped slots and band mismatches are common at 1–2yr depth; retry a
    // few fresh draws within the derive budget instead of skipping the tick.
    const found = await withArchivalSlotRetries(tip, probeBand);
    if (!found) return null;
    slot = found.slot;
  } else {
    const picked = pickSlotForAge(tip, age);
    if (picked === null) return null;
    try {
      if ((await probeBand(picked)) === null) return null;
    } catch {
      return null;
    }
    slot = picked;
  }

  // Per-challenge randomization of transactionDetails between "full" and
  // "accounts". The projection (blockhash / parentSlot / previousBlockhash +
  // per-tx signatures + meta.err/fee/preBalances/postBalances) is invariant
  // across both encodings — verified end-to-end against the utility RPC,
  // 5/5 byte-identical projection hashes. This makes the request shape
  // unpredictable per call so providers can't fingerprint a fixed payload.
  const transactionDetails = Math.random() < 0.5 ? "full" : "accounts";
  return {
    params: {
      slot: Number(slot),
      options: {
        encoding: "json",
        transactionDetails,
        maxSupportedTransactionVersion: 0,
        rewards: false,
        commitment: "confirmed",
      },
    },
    bucket,
  };
}

function pickSlotForAge(
  tip: bigint,
  age: "tip_minus_5" | "last_hour" | "last_24h" | "archival",
): bigint | null {
  // Solana ~2.5 slots/sec.
  const slotsPerHour = 9000n;
  const slotsPerDay = slotsPerHour * 24n;
  const rand = (lo: bigint, hi: bigint) => {
    if (hi <= lo) return null;
    const range = Number(hi - lo);
    return lo + BigInt(Math.floor(Math.random() * range));
  };
  switch (age) {
    case "tip_minus_5":
      // Tip-adjacent freshness probe. Safe with commitment=confirmed —
      // confirmed propagation is ~2s, well within our timing budget.
      return tip > 5n ? tip - BigInt(1 + Math.floor(Math.random() * 5)) : null;
    case "last_hour":
      return rand(tip - slotsPerHour, tip - 5n);
    case "last_24h":
      return rand(tip - slotsPerDay, tip - slotsPerHour);
    case "archival":
      return pickArchivalSlot(tip);
  }
}

export const handlers: MethodHandlers<GetBlockParams, GetBlockResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    const bucket = ctx.bucket as GetBlockBucket;
    return deriveBlockChallenge(ctx, bucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (!buffersEqual(projection.hash, reference.hash)) return "incorrect";
    if (referenceTipSlot - providerTipSlot > STALE_TIP_LAG_SLOTS) return "stale";
    return "correct";
  },
};

