/**
 * getVoteAccounts — Archetype C (set similarity / Jaccard).
 *
 * Returns `{ current: [...], delinquent: [...] }` vote accounts with per-account
 * stake / lastVote that move every slot — byte-equal is impossible. But the SET
 * of vote pubkeys is very stable epoch-to-epoch. So we project the union of
 * `votePubkey`s (dropping all mutable fields) and compare via Jaccard, like
 * getTokenLargestAccounts. Threshold 0.95: the active validator set barely
 * changes within a window, so a high bar still tolerates a few
 * joining/leaving/delinquency-flipping validators (Jaccard absorbs intra-window
 * churn). Wired in record.ts.
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
import { jaccardAtLeast } from "./setsim.js";

export const BUCKETS = ["default"] as const;
/** Jaccard threshold over the vote-pubkey set. */
export const VOTE_ACCOUNTS_JACCARD_THRESHOLD = 0.95;

export interface GetVoteAccountsParams {
  options: { commitment: "finalized"; keepUnstakedDelinquents: false };
}

interface VoteAccount {
  votePubkey?: string;
}
interface GetVoteAccountsResponse {
  current?: VoteAccount[];
  delinquent?: VoteAccount[];
}

const OPTIONS: GetVoteAccountsParams["options"] = {
  commitment: "finalized",
  keepUnstakedDelinquents: false,
};

function keysFromShape(shape: unknown): string[] | null {
  if (!shape || typeof shape !== "object") return null;
  const k = (shape as { keys?: unknown }).keys;
  if (!Array.isArray(k)) return null;
  return k.filter((x): x is string => typeof x === "string");
}

function projectImpl(response: GetVoteAccountsResponse): CanonicalProjection {
  const keys = [
    ...(response?.current ?? []),
    ...(response?.delinquent ?? []),
  ]
    .map((v) => (typeof v.votePubkey === "string" ? v.votePubkey : ""))
    .filter((s) => s.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const shape = { keys };
  return { hash: hashProjection(canonicalize(shape)), shape };
}


/** Consensus match: Jaccard over the vote-pubkey sets. */
export function voteAccountsProjectionsMatch(a: CanonicalProjection, b: CanonicalProjection): boolean {
  if (buffersEqual(a.hash, b.hash)) return true;
  const aa = keysFromShape(a.shape);
  const bb = keysFromShape(b.shape);
  if (!aa || !bb) return false;
  return jaccardAtLeast(new Set(aa), new Set(bb), VOTE_ACCOUNTS_JACCARD_THRESHOLD);
}

export const handlers: MethodHandlers<GetVoteAccountsParams, GetVoteAccountsResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { options: OPTIONS }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    const matches =
      reference.shape != null
        ? voteAccountsProjectionsMatch(projection, reference)
        : buffersEqual(projection.hash, reference.hash);
    if (!matches) return "incorrect";
    if (referenceTipSlot - providerTipSlot > STALE_TIP_LAG_SLOTS) return "stale";
    return "correct";
  },
};
