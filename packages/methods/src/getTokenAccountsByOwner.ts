/**
 * getTokenAccountsByOwner method handlers (native JSON-RPC — NOT the
 * Helius-specific DAS getTokenAccounts, which other panel providers don't
 * serve).
 *
 * Reads CURRENT MUTABLE STATE (token balances), so byte-equal consensus over
 * full account contents is unreachable. The projection is STRUCTURAL-ONLY: the
 * server-side `dataSlice {offset:0,length:64}` returns each token account's
 * mint+owner (immutable) and excludes the mutable `amount` at offset 64.
 * Measures "the right set of token accounts with the right mint/owner", not
 * balances. Note that in-flight balance changes are NOT "covered" by
 * consensus's no_consensus handling — no_consensus discards the measurement;
 * the structural-only projection is what makes this method
 * correctness-scorable.
 *
 * Buckets (kept to reliably-fillable shapes):
 *   by_program__few   — filter {programId: Token}, 1–20 accounts
 *   by_program__many  — filter {programId: Token}, 21–MAX accounts
 *   by_mint__single   — filter {mint}, exactly 1 account (the common ATA case)
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
import { contextSlot, valueDivergenceVerdict } from "./freshness.js";
import { TOKEN_PROGRAM_ID, TOKEN_ACCOUNT_STRUCTURAL_LEN, dataString } from "./spl.js";
import { recentBlock, collectSigners } from "./probe.js";

export const BUCKETS = ["by_program__few", "by_program__many", "by_mint__single"] as const;
export type GetTokenAccountsByOwnerBucket = (typeof BUCKETS)[number];

/** Upper bound on accounts a single challenge may return. */
export const MAX_TABO_ACCOUNTS = 200;
const FEW_MAX = 20;

export type TokenAccountsFilter = { mint: string } | { programId: string };

export interface GetTokenAccountsByOwnerParams {
  owner: string;
  filter: TokenAccountsFilter;
  options: {
    encoding: "base64";
    commitment: "finalized";
    dataSlice: { offset: number; length: number };
  };
}

interface TokenAccountEntry {
  pubkey: string;
  account: { owner: string; data: [string, string] | unknown };
}
// getTokenAccountsByOwner's RPC result is context-wrapped.
interface GetTokenAccountsByOwnerResponse {
  context?: { slot?: number };
  value: TokenAccountEntry[];
}

const OPTIONS: GetTokenAccountsByOwnerParams["options"] = {
  encoding: "base64",
  commitment: "finalized",
  dataSlice: { offset: 0, length: TOKEN_ACCOUNT_STRUCTURAL_LEN },
};

function projectImpl(response: GetTokenAccountsByOwnerResponse): CanonicalProjection {
  const accounts = (response?.value ?? [])
    .map((e) => ({
      pubkey: e.pubkey,
      owner: e.account?.owner ?? "",
      dataPrefix: dataString(e.account?.data), // 64-byte mint+owner slice, no amount
    }))
    .sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
  // Hash the account set only; carry the read slot in the shape (not the hash) for
  // the divergence check.
  const slot = contextSlot(response);
  return { hash: hashProjection(canonicalize({ accounts })), shape: { accounts, slot } };
}

// jsonParsed preflight shape — used only against the utility endpoint to read
// the base58 `mint` without decoding raw bytes ourselves.
interface ParsedTokenAccountsResponse {
  value: Array<{ account?: { data?: { parsed?: { info?: { mint?: string } } } } }>;
}

export async function deriveTokenAccountsByOwnerChallenge(
  ctx: ChallengeContext,
  bucket: GetTokenAccountsByOwnerBucket,
): Promise<{ params: GetTokenAccountsByOwnerParams; bucket: GetTokenAccountsByOwnerBucket } | null> {
  const [filterKind, band] = bucket.split("__") as ["by_program" | "by_mint", "few" | "many" | "single"];

  const block = await recentBlock(ctx);
  if (!block) return null;

  // Owner candidates: transaction signers (base58 wallet pubkeys).
  const owners = collectSigners(block);

  for (const owner of owners) {
    if (filterKind === "by_program") {
      const filter: TokenAccountsFilter = { programId: TOKEN_PROGRAM_ID };
      let res: GetTokenAccountsByOwnerResponse;
      try {
        res = await ctx.utility.call<GetTokenAccountsByOwnerResponse>(
          "getTokenAccountsByOwner",
          [owner, filter, OPTIONS],
        );
      } catch {
        continue;
      }
      const count = res?.value?.length ?? 0;
      if (count <= 0 || count > MAX_TABO_ACCOUNTS) continue;
      const got = count <= FEW_MAX ? "few" : "many";
      if (got === band) return { params: { owner, filter, options: OPTIONS }, bucket };
    } else {
      // by_mint__single: read the owner's token accounts once (jsonParsed gives
      // base58 mints), then find a mint that appears EXACTLY once — counted
      // in-memory. Filtering the full programId set by mint yields the same count
      // as a per-mint getTokenAccountsByOwner query, so the old nested per-mint
      // RPC loop was redundant. One call per owner instead of 1 + one-per-mint.
      let parsed: ParsedTokenAccountsResponse;
      try {
        parsed = await ctx.utility.call<ParsedTokenAccountsResponse>(
          "getTokenAccountsByOwner",
          [owner, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed", commitment: "finalized" }],
        );
      } catch {
        continue;
      }
      const mintCounts = new Map<string, number>();
      for (const e of parsed?.value ?? []) {
        const m = e.account?.data?.parsed?.info?.mint;
        if (typeof m === "string") mintCounts.set(m, (mintCounts.get(m) ?? 0) + 1);
      }
      for (const [mint, count] of mintCounts) {
        if (count === 1) {
          return { params: { owner, filter: { mint }, options: OPTIONS }, bucket };
        }
      }
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetTokenAccountsByOwnerParams, GetTokenAccountsByOwnerResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveTokenAccountsByOwnerChallenge(ctx, ctx.bucket as GetTokenAccountsByOwnerBucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (buffersEqual(projection.hash, reference.hash)) return "correct";
    return valueDivergenceVerdict(projection, reference, providerTipSlot, referenceTipSlot);
  },
};

