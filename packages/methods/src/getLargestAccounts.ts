/**
 * getLargestAccounts — SIMILARITY (Jaccard) method, like getTokenLargestAccounts.
 *
 * Returns `{ context:{slot}, value:[ { address, lamports } × up to 20 ] }` — the
 * largest accounts by lamports network-wide. Balances churn and the rank-~20
 * boundary swaps, so byte-equal over the full list is unreachable; but the top
 * holders are a genuinely shared, global ranking (unlike getClusterNodes' gossip
 * views). So we project the SET of addresses (drop lamports) and compare via
 * Jaccard — two providers agree if their address sets overlap ≥ threshold.
 * Often heavily cached/slow on some providers, so a stale tip → `stale`.
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
import { jaccardAtLeast } from "./setsim.js";

export const BUCKETS = ["default"] as const;
export type GetLargestAccountsBucket = (typeof BUCKETS)[number];

/** ~0.75 tolerates 2–3 rank-boundary swaps on a 20-element list (as TLA). */
export const LARGEST_ACCOUNTS_JACCARD_THRESHOLD = 0.75;

export interface GetLargestAccountsParams {
  options: { commitment: "finalized" };
}

interface LargestEntry {
  address?: string;
}
interface GetLargestAccountsResponse {
  context?: { slot?: number };
  value: LargestEntry[];
}

const OPTIONS: GetLargestAccountsParams["options"] = { commitment: "finalized" };

function addressesFromShape(shape: unknown): string[] | null {
  if (!shape || typeof shape !== "object") return null;
  const a = (shape as { addresses?: unknown }).addresses;
  if (!Array.isArray(a)) return null;
  return a.filter((x): x is string => typeof x === "string");
}

function projectImpl(response: GetLargestAccountsResponse): CanonicalProjection {
  const addresses = (response?.value ?? [])
    .map((e) => (typeof e.address === "string" ? e.address : ""))
    .filter((s) => s.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shape = { addresses };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

/** Consensus / auditor match: Jaccard over the address sets. */
export function largestAccountsProjectionsMatch(a: CanonicalProjection, b: CanonicalProjection): boolean {
  if (buffersEqual(a.hash, b.hash)) return true;
  const aa = addressesFromShape(a.shape);
  const bb = addressesFromShape(b.shape);
  if (!aa || !bb) return false;
  return jaccardAtLeast(new Set(aa), new Set(bb), LARGEST_ACCOUNTS_JACCARD_THRESHOLD);
}

export const handlers: MethodHandlers<GetLargestAccountsParams, GetLargestAccountsResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { options: OPTIONS }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    const matches =
      reference.shape != null
        ? largestAccountsProjectionsMatch(projection, reference)
        : buffersEqual(projection.hash, reference.hash);
    if (!matches) return "incorrect";
    if (referenceTipSlot - providerTipSlot > 2n) return "stale";
    return "correct";
  },
};

