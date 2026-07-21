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
 * Activity classification: query the utility endpoint for limit:100 sigs and
 * count how many land in the last hour. ≥50 → high, 1–49 → medium, 0 → low.
 *
 * Cached for 30 minutes per address to bound preflight cost. Shared by the
 * address-history methods (getSignaturesForAddress, getTransactionsForAddress);
 * probes with standard getSignaturesForAddress only, so it works regardless of
 * whether the utility endpoint serves any custom method.
 */
const activityCache = new Map<string, { activity: "high" | "medium" | "low"; expiresAt: number }>();

export async function classifyActivity(
  ctx: ChallengeContext,
  address: string,
): Promise<"high" | "medium" | "low"> {
  const now = Date.now();
  const cached = activityCache.get(address);
  if (cached && cached.expiresAt > now) return cached.activity;

  let sigs: Array<{ blockTime?: number | null }>;
  try {
    sigs = await ctx.utility.call<Array<{ blockTime?: number | null }>>(
      "getSignaturesForAddress",
      [address, { limit: 100 }],
    );
  } catch {
    return "low";
  }
  const oneHourAgo = (Date.now() / 1000) - 3600;
  const recent = sigs.filter((s) => (s.blockTime ?? 0) > oneHourAgo).length;
  const activity: "high" | "medium" | "low" =
    recent >= 50 ? "high" : recent >= 1 ? "medium" : "low";
  activityCache.set(address, { activity, expiresAt: now + 30 * 60 * 1000 });
  return activity;
}

/**
 * Small module-level TTL cache (generalizes the `activityCache` idiom above).
 * The generator process is long-lived and `deriveChallenge` gets a fresh
 * ChallengeContext each tick, so cross-tick memory must live at module scope.
 * Used to remember validated derivation inputs (real mints, valid anchors) so
 * warm ticks skip re-scanning a random block for them.
 */
export function makeTtlCache<V>(ttlMs: number): {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
} {
  const m = new Map<string, { value: V; expiresAt: number }>();
  return {
    get(key: string): V | undefined {
      const e = m.get(key);
      if (e && e.expiresAt > Date.now()) return e.value;
      if (e) m.delete(key); // expired — drop it
      return undefined;
    },
    set(key: string, value: V): void {
      m.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

export const SLOTS_PER_EPOCH = 432_000n;

/**
 * Archival band: tip − (182 … 365) epochs ≈ 1–2 years back. Deep enough that
 * answers come from real archive storage (cold Bigtable reads), not the
 * recent-ledger retention that any non-archive node serves — the band exists
 * to measure archive depth, so it must sit well past every provider's warm
 * window. Epoch-based banding only: slot math is exact; the calendar mapping
 * (~2.0–2.2 days/epoch) is approximate within ~10%, which is fine for a
 * sampling band.
 */
export const ARCHIVAL_EPOCHS_MIN = 182n;
export const ARCHIVAL_EPOCHS_MAX = 365n;

/** Per-call utility timeout for deep archival fetches (cold archive reads). */
export const ARCHIVAL_UTILITY_TIMEOUT_MS = 10_000;

/**
 * Wall-clock budget for one archival derivation (slot retries included).
 * Derivation runs inside one generator tickCombo raced against the 25s tick
 * ceiling; 12s here keeps the archival worst case comfortably under it.
 */
export const ARCHIVAL_DERIVE_BUDGET_MS = 12_000;

/** Uniform random slot in the archival band; null when tip is too small. */
export function pickArchivalSlot(tip: bigint): bigint | null {
  const lo = tip - SLOTS_PER_EPOCH * ARCHIVAL_EPOCHS_MAX;
  const hi = tip - SLOTS_PER_EPOCH * ARCHIVAL_EPOCHS_MIN;
  if (lo <= 0n || hi <= lo) return null;
  return lo + BigInt(Math.floor(Math.random() * Number(hi - lo)));
}

/**
 * Retry-on-skipped-slot loop for archival derivation (generalizes the
 * honeypot seeder's pattern). Draws a fresh archival slot per attempt and
 * calls `probe(slot)`; a null/thrown probe means "skipped slot or fetch
 * failure — try another". Bounded by attempts AND wall-clock budget: no new
 * attempt is launched past the budget, so a derive stays inside the
 * generator's tick ceiling (a final in-flight call may overrun slightly).
 * Returns null when nothing usable was found — callers treat that as
 * "derivation failed this tick", same as everywhere else.
 */
export async function withArchivalSlotRetries<T>(
  tip: bigint,
  probe: (slot: bigint) => Promise<T | null>,
  opts?: { maxAttempts?: number; budgetMs?: number },
): Promise<{ slot: bigint; value: T } | null> {
  const maxAttempts = opts?.maxAttempts ?? 4;
  const budgetMs = opts?.budgetMs ?? ARCHIVAL_DERIVE_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < maxAttempts && Date.now() < deadline; i++) {
    const slot = pickArchivalSlot(tip);
    if (slot === null) return null;
    try {
      const value = await probe(slot);
      if (value !== null) return { slot, value };
    } catch {
      // skipped slot / fetch failure — try another draw
    }
  }
  return null;
}

/**
 * Pick a slot in a finalized age band, for methods pinned to immutable history
 * (getBlockTime, getBlockCommitment, getBlocks, getBlockProduction). Solana
 * runs ~2.5 slots/s; 432k slots ≈ one epoch.
 *   - "recent_finalized": tip − (150 … 9000) — finalized (>13s old) but recent.
 *   - "archival":         tip − (182 … 365 epochs) ≈ 1–2 years — true archive.
 * Returns null when the slot window is empty.
 */
export function pickFinalizedSlot(
  ctx: ChallengeContext,
  age: "recent_finalized" | "archival",
): bigint | null {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;
  if (age === "recent_finalized") {
    if (tip <= 9000n) return null;
    return tip - BigInt(150 + Math.floor(Math.random() * 8850));
  }
  return pickArchivalSlot(tip);
}

/**
 * Batch-fetch account states for many pubkeys via `getMultipleAccounts`,
 * replacing the per-candidate serial `getAccountInfo` scans that dominated the
 * utility endpoint's load. Requests in chunks of 100 (the JSON-RPC limit) and
 * returns one entry per input pubkey, in input order — index i corresponds to
 * `pubkeys[i]`. A failed/missing chunk yields nulls for that range so indices
 * stay aligned. Generic over the account-value shape so callers pick the
 * encoding (base64 for owner/space/executable, jsonParsed for `data.parsed`).
 */
export async function batchGetAccounts<T>(
  ctx: ChallengeContext,
  pubkeys: string[],
  options: unknown,
  chunkSize = 100,
): Promise<Array<T | null>> {
  const out: Array<T | null> = [];
  for (let i = 0; i < pubkeys.length; i += chunkSize) {
    const chunk = pubkeys.slice(i, i + chunkSize);
    let value: Array<T | null> = [];
    try {
      const res = await ctx.utility.call<{ value?: Array<T | null> }>("getMultipleAccounts", [
        chunk,
        options,
      ]);
      value = res?.value ?? [];
    } catch {
      // Leave `value` empty → chunk padded with nulls below (indices stay aligned).
    }
    for (let j = 0; j < chunk.length; j++) out.push(value[j] ?? null);
  }
  return out;
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
