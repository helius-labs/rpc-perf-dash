/**
 * getTokenAccountBalance method handlers — HYBRID value method.
 *
 * Returns `{ context:{slot}, value:{ amount, decimals, uiAmount, uiAmountString } }`
 * for a token account. Same shape and mutability profile as getTokenSupply:
 * `amount` (the account's balance) drifts on transfer; `decimals` is immutable.
 * We hash `{ amount, decimals }` as the value tier (default byte-equal
 * consensus), verify when a ≥3-voter value-majority forms, and fall back to a
 * freshness verdict via `livenessFallback` when the balance churned in-window.
 * See getBalance.ts / docs/methodology.md for the full Hybrid rationale.
 *
 * Edge case: a token account closed between derive and fanout returns an RPC
 * error → scored `incorrect`. Sourcing token accounts of recently-active
 * signers keeps this rare; we accept it as noise rather than special-casing.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { TOKEN_PROGRAM_ID } from "./spl.js";
import { contextSlot, freshnessVerdict } from "./freshness.js";
import { recentBlock, collectSigners } from "./probe.js";

export const BUCKETS = ["token_account"] as const;
export type GetTokenAccountBalanceBucket = (typeof BUCKETS)[number];

export interface GetTokenAccountBalanceParams {
  tokenAccount: string;
  options: { commitment: "finalized" };
}

interface TokenAmount {
  amount?: string;
  decimals?: number;
  uiAmount?: number | null;
  uiAmountString?: string;
}
interface GetTokenAccountBalanceResponse {
  context?: { slot?: number };
  value: TokenAmount | null;
}
interface TokenAccountsResponse {
  value: Array<{ pubkey?: string }>;
}

const OPTIONS: GetTokenAccountBalanceParams["options"] = { commitment: "finalized" };

function projectImpl(response: GetTokenAccountBalanceResponse): CanonicalProjection {
  const slot = contextSlot(response);
  const v = response?.value ?? null;
  const amount = typeof v?.amount === "string" ? v.amount : "";
  const decimals = typeof v?.decimals === "number" ? v.decimals : -1;
  const hash = hashProjection(canonicalize({ amount, decimals }));
  return { hash, shape: { slot, amount, decimals } };
}

export async function deriveTokenAccountBalanceChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetTokenAccountBalanceParams; bucket: GetTokenAccountBalanceBucket } | null> {
  const block = await recentBlock(ctx);
  if (!block) return null;

  // Pick a real token-account pubkey from a recent signer's token accounts.
  for (const owner of collectSigners(block)) {
    let res: TokenAccountsResponse;
    try {
      res = await ctx.utility.call<TokenAccountsResponse>("getTokenAccountsByOwner", [
        owner,
        { programId: TOKEN_PROGRAM_ID },
        { encoding: "base64", commitment: "finalized" },
      ]);
    } catch {
      continue;
    }
    for (const e of res?.value ?? []) {
      if (typeof e.pubkey === "string") {
        return { params: { tokenAccount: e.pubkey, options: OPTIONS }, bucket: "token_account" };
      }
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetTokenAccountBalanceParams, GetTokenAccountBalanceResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveTokenAccountBalanceChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (buffersEqual(projection.hash, reference.hash)) {
      if (referenceTipSlot - providerTipSlot > 2n) return "stale";
      return "correct";
    }
    if (providerTipSlot > referenceTipSlot) return "stale";
    return "incorrect";
  },
  livenessFallback(projection, referenceTipSlot): Correctness {
    return freshnessVerdict(projection, referenceTipSlot);
  },
};

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
