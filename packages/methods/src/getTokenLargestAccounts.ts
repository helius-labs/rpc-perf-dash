/**
 * getTokenLargestAccounts method handlers — SIMILARITY (Jaccard) method.
 *
 * Returns `{ context:{slot}, value:[ { address, amount, decimals, uiAmount,
 * uiAmountString } × up to 20 ] }` — the top-20 holders of a mint. Amounts
 * churn on every transfer and the rank-~20 boundary swaps constantly, so
 * byte-equal over the full list is unreachable. But the top holders of a real
 * mint are stable; only the tail flips.
 *
 * So we project the SET of holder ADDRESSES (drop amounts entirely) and compare
 * via Jaccard, exactly like getSignaturesForAddress: two providers "agree" if
 * their address sets overlap ≥ TLA_JACCARD_THRESHOLD. With 20 elements each
 * boundary swap costs ~0.1 Jaccard, so 0.75 tolerates ~2–3 rank-boundary flips.
 * Wired in record.ts. Tune the threshold against live boundary-swap rates.
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
import { STALE_TIP_LAG_SLOTS } from "./freshness.js";
import { TOKEN_PROGRAM_ID } from "./spl.js";
import { recentBlock, collectSigners } from "./probe.js";
import { jaccardAtLeast } from "./setsim.js";

export const BUCKETS = ["mint"] as const;
export type GetTokenLargestAccountsBucket = (typeof BUCKETS)[number];

/**
 * Jaccard overlap threshold for two top-20 holder sets to be considered equal.
 * 0.75 ≈ tolerate 2–3 rank-boundary swaps on a 20-element list.
 */
export const TLA_JACCARD_THRESHOLD = 0.75;

/** Don't challenge mints with too few holders — one transfer is a huge set change. */
const MIN_HOLDERS = 3;

export interface GetTokenLargestAccountsParams {
  mint: string;
  options: { commitment: "finalized" };
}

interface LargestEntry {
  address?: string;
}
interface GetTokenLargestAccountsResponse {
  context?: { slot?: number };
  value: LargestEntry[];
}
interface ParsedTokenAccountsResponse {
  value: Array<{ account?: { data?: { parsed?: { info?: { mint?: string } } } } }>;
}

const OPTIONS: GetTokenLargestAccountsParams["options"] = { commitment: "finalized" };

function addressesFromShape(shape: unknown): string[] | null {
  if (!shape || typeof shape !== "object") return null;
  const a = (shape as { addresses?: unknown }).addresses;
  if (!Array.isArray(a)) return null;
  return a.filter((x): x is string => typeof x === "string");
}

function projectImpl(response: GetTokenLargestAccountsResponse): CanonicalProjection {
  const addresses = (response?.value ?? [])
    .map((e) => (typeof e.address === "string" ? e.address : ""))
    .filter((s) => s.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shape = { addresses };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

/** Consensus match: Jaccard over the holder address sets. */
export function tlaProjectionsMatch(a: CanonicalProjection, b: CanonicalProjection): boolean {
  if (buffersEqual(a.hash, b.hash)) return true;
  const aa = addressesFromShape(a.shape);
  const bb = addressesFromShape(b.shape);
  if (!aa || !bb) return false;
  return jaccardAtLeast(new Set(aa), new Set(bb), TLA_JACCARD_THRESHOLD);
}

export async function deriveTokenLargestAccountsChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetTokenLargestAccountsParams; bucket: GetTokenLargestAccountsBucket } | null> {
  const block = await recentBlock(ctx);
  if (!block) return null;

  // Source a real mint (same jsonParsed extraction as getTokenSupply), then
  // confirm getTokenLargestAccounts returns ≥ MIN_HOLDERS so the Jaccard
  // compare has a meaningful set to work with.
  for (const owner of collectSigners(block)) {
    let parsed: ParsedTokenAccountsResponse;
    try {
      parsed = await ctx.utility.call<ParsedTokenAccountsResponse>("getTokenAccountsByOwner", [
        owner,
        { programId: TOKEN_PROGRAM_ID },
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
    } catch {
      continue;
    }
    const mints = new Set<string>();
    for (const e of parsed?.value ?? []) {
      const m = e.account?.data?.parsed?.info?.mint;
      if (typeof m === "string") mints.add(m);
    }
    for (const mint of mints) {
      let res: GetTokenLargestAccountsResponse;
      try {
        res = await ctx.utility.call<GetTokenLargestAccountsResponse>("getTokenLargestAccounts", [mint, OPTIONS]);
      } catch {
        continue;
      }
      if ((res?.value?.length ?? 0) >= MIN_HOLDERS) {
        return { params: { mint, options: OPTIONS }, bucket: "mint" };
      }
    }
  }
  return null;
}

export const handlers: MethodHandlers<GetTokenLargestAccountsParams, GetTokenLargestAccountsResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveTokenLargestAccountsChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    const matches =
      reference.shape != null
        ? tlaProjectionsMatch(projection, reference)
        : buffersEqual(projection.hash, reference.hash);
    if (!matches) return "incorrect";
    if (referenceTipSlot - providerTipSlot > STALE_TIP_LAG_SLOTS) return "stale";
    return "correct";
  },
};

