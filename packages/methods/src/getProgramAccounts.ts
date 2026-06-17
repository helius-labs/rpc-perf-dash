/**
 * getProgramAccounts method handlers (base method — no V2 pagination).
 *
 * Two hard problems, both addressed here:
 *  1. BOUNDEDNESS. Unbounded getProgramAccounts can return millions of accounts.
 *     Every challenge sends a `filters` array (dataSize + memcmp anchored to a
 *     value derived at challenge time) and a server-side `dataSlice
 *     {offset:0,length:64}`, and deriveChallenge preflights the query and
 *     rejects anchors whose result exceeds MAX_PGA_ACCOUNTS.
 *  2. MUTABLE STATE. The accounts returned have mutable balances, so byte-equal
 *     consensus over their full contents is unreachable. The projection is
 *     STRUCTURAL-ONLY: the 64-byte dataSlice captures the SPL token account's
 *     mint+owner (immutable) and excludes the mutable `amount` at offset 64.
 *     Measures "the right account SET with the right mint/owner", not balances.
 *
 * Buckets: filter_kind × result_size_band, all anchored on the well-supported
 * SPL Token program (no fragile hardcoded program IDs):
 *   filter_kind: by_mint  (memcmp offset 0  = mint  → that mint's holder set)
 *                by_owner (memcmp offset 32 = owner → a wallet's token accounts)
 *   size_band:   small (1–20) | medium (21–MAX_PGA_ACCOUNTS)
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
  TOKEN_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_SIZE,
  SPL_MINT_SIZE,
  TOKEN_ACCOUNT_STRUCTURAL_LEN,
  dataString,
} from "./spl.js";

const FILTER_KIND = ["by_mint", "by_owner"] as const;
const SIZE_BAND = ["small", "medium"] as const;

export const BUCKETS = FILTER_KIND.flatMap((f) => SIZE_BAND.map((s) => `${f}__${s}`));
export type GetProgramAccountsBucket = (typeof BUCKETS)[number];

/** Upper bound on accounts a single challenge may return. Keeps payloads and
 * cross-provider set comparison tractable. */
export const MAX_PGA_ACCOUNTS = 200;
const SMALL_MAX = 20;

export interface GetProgramAccountsParams {
  programId: string;
  options: {
    encoding: "base64";
    commitment: "finalized";
    filters: Array<{ dataSize: number } | { memcmp: { offset: number; bytes: string } }>;
    dataSlice: { offset: number; length: number };
  };
}

interface ProgramAccountEntry {
  pubkey: string;
  account: { owner: string; data: [string, string] | unknown };
}
// getProgramAccounts (base method, no withContext) returns a bare array.
type GetProgramAccountsResponse = ProgramAccountEntry[];

function bandOf(count: number): "small" | "medium" | null {
  if (count <= 0 || count > MAX_PGA_ACCOUNTS) return null;
  return count <= SMALL_MAX ? "small" : "medium";
}

function projectImpl(response: GetProgramAccountsResponse): CanonicalProjection {
  const accounts = (response ?? [])
    .map((e) => ({
      pubkey: e.pubkey,
      owner: e.account?.owner ?? "",
      // data is already the 64-byte structural slice (mint+owner), sliced
      // server-side via dataSlice — no mutable `amount`.
      dataPrefix: dataString(e.account?.data),
    }))
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
  const shape = { accounts };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

function optionsFor(
  filterKind: "by_mint" | "by_owner",
  anchor: string,
): GetProgramAccountsParams["options"] {
  const offset = filterKind === "by_mint" ? 0 : 32;
  return {
    encoding: "base64",
    commitment: "finalized",
    filters: [{ dataSize: SPL_TOKEN_ACCOUNT_SIZE }, { memcmp: { offset, bytes: anchor } }],
    dataSlice: { offset: 0, length: TOKEN_ACCOUNT_STRUCTURAL_LEN },
  };
}

interface AccountKeyEntry {
  pubkey: string;
  signer?: boolean;
}
interface BlockKeysProbe {
  transactions: Array<{ transaction: { accountKeys?: AccountKeyEntry[] } }>;
}
interface AccountInfoProbe {
  value: { owner: string; executable: boolean; space?: number } | null;
}

export async function deriveProgramAccountsChallenge(
  ctx: ChallengeContext,
  bucket: GetProgramAccountsBucket,
): Promise<{ params: GetProgramAccountsParams; bucket: GetProgramAccountsBucket } | null> {
  const [filterKind, band] = bucket.split("__") as ["by_mint" | "by_owner", "small" | "medium"];
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

  // Candidate anchors:
  //   by_owner → transaction signers (base58 wallet pubkeys, used as the SPL
  //              `owner` at offset 32).
  //   by_mint  → account keys that ARE mints (owner=Token, space=82); their
  //              pubkey is the base58 mint used at offset 0.
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const tx of block.transactions ?? []) {
    for (const k of tx.transaction.accountKeys ?? []) {
      if (!k || typeof k.pubkey !== "string" || seen.has(k.pubkey)) continue;
      if (filterKind === "by_owner" && k.signer === true) {
        seen.add(k.pubkey);
        candidates.push(k.pubkey);
      } else if (filterKind === "by_mint") {
        seen.add(k.pubkey);
        candidates.push(k.pubkey);
      }
    }
    if (candidates.length > 120) break;
  }

  for (const anchor of candidates) {
    if (filterKind === "by_mint") {
      // Confirm the candidate is actually a mint before using it as an anchor.
      let probe: AccountInfoProbe;
      try {
        probe = await ctx.utility.call<AccountInfoProbe>("getAccountInfo", [
          anchor,
          { encoding: "base64", commitment: "finalized" },
        ]);
      } catch {
        continue;
      }
      const v = probe?.value;
      if (!v || v.owner !== TOKEN_PROGRAM_ID || (v.space ?? 0) !== SPL_MINT_SIZE) continue;
    }

    const options = optionsFor(filterKind, anchor);
    let result: GetProgramAccountsResponse;
    try {
      result = await ctx.utility.call<GetProgramAccountsResponse>("getProgramAccounts", [
        TOKEN_PROGRAM_ID,
        options,
      ]);
    } catch {
      continue;
    }
    if (bandOf(result?.length ?? 0) === band) {
      return { params: { programId: TOKEN_PROGRAM_ID, options }, bucket };
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetProgramAccountsParams, GetProgramAccountsResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveProgramAccountsChallenge(ctx, ctx.bucket as GetProgramAccountsBucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (buffersEqual(projection.hash, reference.hash)) {
      if (referenceTipSlot - providerTipSlot > 2n) return "stale";
      return "correct";
    }
    // Hash mismatch — typically set-membership churn (an account opened/closed
    // between slots). A provider at a newer slot is fresh-but-divergent → stale.
    if (providerTipSlot > referenceTipSlot) return "stale";
    return "incorrect";
  },
};

