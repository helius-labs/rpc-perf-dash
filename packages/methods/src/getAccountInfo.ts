/**
 * getAccountInfo method handlers.
 *
 * getAccountInfo reads CURRENT MUTABLE STATE (lamports, account data), so
 * byte-equal cross-provider consensus over a changing account is unreachable by
 * construction. The projection is therefore STRUCTURAL-ONLY: it hashes the
 * fields that don't drift across slots (owner, executable, space, and a
 * type-aware structural slice of the data) and EXCLUDES the mutable balance
 * (lamports, SPL token `amount`, mint `supply`). See docs/methodology.md and
 * packages/methods/src/spl.ts.
 *
 * Buckets: account type — wallet | token_account | mint | program | nonexistent.
 * Correctness-bearing buckets are mint / program / nonexistent (immutable or
 * slow-changing structural fields). wallet / token_account are mutable in their
 * balances but their hashed structural fields (owner/space, mint+owner) are
 * stable, so they remain correctness-scored under this projection.
 *
 * What the projection measures: "the right account, with the right owner and
 * layout" — NOT balances. That's the honest correctness signal standard
 * JSON-RPC can support cross-provider (no exact slot pinning available).
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
  buffersEqual,
} from "@rpcbench/shared";
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_SIZE,
  SPL_MINT_SIZE,
  dataString,
  structuralDataPrefix,
} from "./spl.js";

export const BUCKETS = [
  "wallet",
  "token_account",
  "mint",
  "program",
  "nonexistent",
] as const;
export type GetAccountInfoBucket = (typeof BUCKETS)[number];

export interface GetAccountInfoParams {
  pubkey: string;
  options: { encoding: "base64"; commitment: "finalized" };
}

interface AccountValue {
  lamports: number;
  owner: string;
  data: [string, string] | unknown;
  executable: boolean;
  space?: number;
  rentEpoch?: number;
}

// getAccountInfo's RPC result is the context-wrapped object { context, value }.
interface GetAccountInfoResponse {
  context?: { slot?: number; apiVersion?: string };
  value: AccountValue | null;
}

/** Classify an account value into one of our buckets (or null if it's a type
 * we don't bucket). Deterministic from the response — used at both derive time
 * and project time so the two always agree. */
function accountType(v: AccountValue): GetAccountInfoBucket | null {
  if (v.executable === true) return "program";
  const space = v.space ?? 0;
  if (v.owner === TOKEN_PROGRAM_ID) {
    if (space === SPL_TOKEN_ACCOUNT_SIZE) return "token_account";
    if (space === SPL_MINT_SIZE) return "mint";
    return null;
  }
  if (v.owner === SYSTEM_PROGRAM_ID && space === 0) return "wallet";
  return null;
}

function projectImpl(response: GetAccountInfoResponse): CanonicalProjection {
  const value = response?.value ?? null;
  if (value === null) {
    const shape = { exists: false };
    return { hash: hashProjection(canonicalize(shape)), shape };
  }
  const space = value.space ?? 0;
  const dataPrefix = structuralDataPrefix(dataString(value.data), value.owner, space);
  // Structural-only: lamports is deliberately omitted from the hashed shape.
  const shape = {
    exists: true,
    owner: value.owner,
    executable: value.executable,
    space,
    dataPrefix,
  };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

interface AccountKeyEntry {
  pubkey: string;
  signer?: boolean;
}
interface BlockKeysProbe {
  blockhash?: string;
  transactions: Array<{ transaction: { accountKeys?: AccountKeyEntry[] } }>;
}

const OPTIONS: GetAccountInfoParams["options"] = { encoding: "base64", commitment: "finalized" };

export async function deriveAccountInfoChallenge(
  ctx: ChallengeContext,
  bucket: GetAccountInfoBucket,
): Promise<{ params: GetAccountInfoParams; bucket: GetAccountInfoBucket } | null> {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;

  const probeSlot = tip - BigInt(1 + Math.floor(Math.random() * 9000));
  let block: BlockKeysProbe;
  try {
    block = await ctx.utility.call<BlockKeysProbe>("getBlock", [
      Number(probeSlot),
      { encoding: "json", transactionDetails: "accounts", maxSupportedTransactionVersion: 0, rewards: false, commitment: "confirmed" },
    ]);
  } catch {
    return null;
  }

  // A blockhash is a base58 32-byte value with valid pubkey format that
  // virtually never maps to a real account — getAccountInfo returns value:null.
  if (bucket === "nonexistent") {
    const hash = block.blockhash;
    if (!hash) return null;
    return { params: { pubkey: hash, options: OPTIONS }, bucket };
  }

  // Gather candidate account keys from the block and find one whose live type
  // matches the requested bucket.
  const candidates = new Set<string>();
  for (const tx of block.transactions ?? []) {
    for (const k of tx.transaction.accountKeys ?? []) {
      if (k && typeof k.pubkey === "string") candidates.add(k.pubkey);
    }
    if (candidates.size > 120) break;
  }

  for (const pubkey of candidates) {
    let res: GetAccountInfoResponse;
    try {
      res = await ctx.utility.call<GetAccountInfoResponse>("getAccountInfo", [pubkey, OPTIONS]);
    } catch {
      continue;
    }
    const value = res?.value ?? null;
    if (value === null) continue;
    if (accountType(value) === bucket) {
      return { params: { pubkey, options: OPTIONS }, bucket };
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetAccountInfoParams, GetAccountInfoResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveAccountInfoChallenge(ctx, ctx.bucket as GetAccountInfoBucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    const provExists = (projection.shape as { exists?: boolean })?.exists;
    const refExists = (reference.shape as { exists?: boolean })?.exists;

    if (buffersEqual(projection.hash, reference.hash)) {
      if (referenceTipSlot - providerTipSlot > 2n) return "stale";
      return "correct";
    }
    // Hash mismatch. Mutable-state reorder: a provider that observed a NEWER
    // slot than the reference is fresh-but-divergent → stale, not incorrect.
    if (refExists === true && provExists === false) return "incomplete";
    if (providerTipSlot > referenceTipSlot) return "stale";
    return "incorrect";
  },
};

