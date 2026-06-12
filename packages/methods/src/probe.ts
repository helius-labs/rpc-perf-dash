/**
 * Shared challenge-derivation probe used by the account/mint-sourcing methods
 * (getBalance, getTokenSupply, getTokenLargestAccounts, getTokenAccountBalance).
 *
 * Mirrors the recent-block-signer pattern already used by getAccountInfo /
 * getTokenAccountsByOwner: fetch a random recent block with
 * `transactionDetails: "accounts"` off the utility endpoint, then read account
 * keys / transaction signers as real, on-chain candidate inputs.
 */

import type { ChallengeContext } from "@rpcbench/shared";

interface AccountKeyEntry {
  pubkey: string;
  signer?: boolean;
}
export interface RecentBlock {
  blockhash?: string;
  transactions: Array<{ transaction: { accountKeys?: AccountKeyEntry[] } }>;
}

/**
 * Fetch a random recent block (1–9000 slots behind tip ≈ last hour) with
 * account keys. Returns null when there are no slots yet or the fetch fails —
 * callers treat null as "derivation failed", same as the existing methods.
 */
export async function recentBlock(ctx: ChallengeContext): Promise<RecentBlock | null> {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;
  const probeSlot = tip - BigInt(1 + Math.floor(Math.random() * 9000));
  try {
    return await ctx.utility.call<RecentBlock>("getBlock", [
      Number(probeSlot),
      {
        encoding: "json",
        transactionDetails: "accounts",
        maxSupportedTransactionVersion: 0,
        rewards: false,
        commitment: "confirmed",
      },
    ]);
  } catch {
    return null;
  }
}

/** Collect distinct transaction signers (base58 wallet pubkeys) from a block. */
export function collectSigners(block: RecentBlock, max = 120): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tx of block.transactions ?? []) {
    for (const k of tx.transaction.accountKeys ?? []) {
      if (k && typeof k.pubkey === "string" && k.signer === true && !seen.has(k.pubkey)) {
        seen.add(k.pubkey);
        out.push(k.pubkey);
      }
    }
    if (out.length > max) break;
  }
  return out;
}

/**
 * Pick a slot in a finalized age band, for methods pinned to immutable history
 * (getBlockTime, getBlockCommitment, getBlocks, getBlockProduction). Solana
 * runs ~2.5 slots/s; 432k slots ≈ one epoch.
 *   - "recent_finalized": tip − (150 … 9000) — finalized (>13s old) but recent.
 *   - "archival":         tip − (1 … 10 epochs) — deep history.
 * Returns null when the slot window is empty.
 */
export function pickFinalizedSlot(
  ctx: ChallengeContext,
  age: "recent_finalized" | "archival",
): bigint | null {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;
  const slotsPerEpoch = 432_000n;
  if (age === "recent_finalized") {
    if (tip <= 9000n) return null;
    return tip - BigInt(150 + Math.floor(Math.random() * 8850));
  }
  // archival: 1–10 epochs back
  const lo = tip - slotsPerEpoch * 10n;
  const hi = tip - slotsPerEpoch;
  if (hi <= lo) return null;
  return lo + BigInt(Math.floor(Math.random() * Number(hi - lo)));
}

/** Collect distinct account keys (signer or not) from a block. */
export function collectAccountKeys(block: RecentBlock, max = 120): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tx of block.transactions ?? []) {
    for (const k of tx.transaction.accountKeys ?? []) {
      if (k && typeof k.pubkey === "string" && !seen.has(k.pubkey)) {
        seen.add(k.pubkey);
        out.push(k.pubkey);
      }
    }
    if (out.length > max) break;
  }
  return out;
}
