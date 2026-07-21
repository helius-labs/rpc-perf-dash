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
import { contextSlot, valueDivergenceVerdict } from "./freshness.js";
import {
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_SIZE,
  SPL_MINT_SIZE,
  dataString,
  structuralDataPrefix,
} from "./spl.js";
import { recentBlock, collectAccountKeys, batchGetAccounts } from "./probe.js";

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
  // Carry the read slot in the shape (NOT the hash) for the divergence check.
  const slot = contextSlot(response);
  const value = response?.value ?? null;
  if (value === null) {
    const hashed = { exists: false };
    return { hash: hashProjection(canonicalize(hashed)), shape: { ...hashed, slot } };
  }
  const space = value.space ?? 0;
  const dataPrefix = structuralDataPrefix(dataString(value.data), value.owner, space);
  // Structural-only: lamports is deliberately omitted from the hashed shape.
  const hashed = {
    exists: true,
    owner: value.owner,
    executable: value.executable,
    space,
    dataPrefix,
  };
  return { hash: hashProjection(canonicalize(hashed)), shape: { ...hashed, slot } };
}

const OPTIONS: GetAccountInfoParams["options"] = { encoding: "base64", commitment: "finalized" };

export async function deriveAccountInfoChallenge(
  ctx: ChallengeContext,
  bucket: GetAccountInfoBucket,
): Promise<{ params: GetAccountInfoParams; bucket: GetAccountInfoBucket } | null> {
  const block = await recentBlock(ctx);
  if (!block) return null;

  // A blockhash is a base58 32-byte value with valid pubkey format that
  // virtually never maps to a real account — getAccountInfo returns value:null.
  if (bucket === "nonexistent") {
    const hash = block.blockhash;
    if (!hash) return null;
    return { params: { pubkey: hash, options: OPTIONS }, bucket };
  }

  // Gather candidate account keys from the block and find one whose live type
  // matches the requested bucket. Batch the account reads via
  // getMultipleAccounts (chunks of 100) instead of one serial getAccountInfo
  // per candidate — same match result, ~60× fewer round-trips.
  const candidates = collectAccountKeys(block);
  if (candidates.length === 0) return null;

  const infos = await batchGetAccounts<AccountValue>(ctx, candidates, OPTIONS);
  for (let i = 0; i < candidates.length; i++) {
    const value = infos[i];
    if (!value) continue;
    if (accountType(value) === bucket) {
      return { params: { pubkey: candidates[i]!, options: OPTIONS }, bucket };
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

    if (buffersEqual(projection.hash, reference.hash)) return "correct";
    // A provider that sees the account as absent where the panel sees it present
    // is incomplete (not a value divergence).
    if (refExists === true && provExists === false) return "incomplete";
    return valueDivergenceVerdict(projection, reference, providerTipSlot, referenceTipSlot);
  },
};

