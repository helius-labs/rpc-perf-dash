/**
 * getInflationReward — Archetype A (deterministic byte-equal).
 *
 * Returns the per-address inflation reward for an epoch. For a COMPLETED epoch
 * the reward is immutable, so every provider returns identical figures.
 * Derivation pulls a handful of real vote-account pubkeys from the auditor and
 * queries the previous epoch. (Vote accounts may legitimately have a null
 * reward; that's fine — providers still agree on null for the same input.)
 */

import {
  byteEqualHash,
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";

export const BUCKETS = ["prev_epoch"] as const;
export type GetInflationRewardBucket = (typeof BUCKETS)[number];

/** How many vote pubkeys to query per challenge. */
const ADDR_COUNT = 5;

export interface GetInflationRewardParams {
  addresses: string[];
  options: { epoch: number };
}

interface RewardEntry {
  epoch?: number;
  effectiveSlot?: number;
  amount?: number;
  commission?: number | null;
}
type GetInflationRewardResponse = Array<RewardEntry | null>;

interface VoteAccountsResponse {
  current?: Array<{ votePubkey?: string }>;
}

function projectImpl(response: GetInflationRewardResponse): CanonicalProjection {
  // Keep the per-address record in the SAME order we requested (the RPC
  // preserves request order). Drop postBalance — amount/effectiveSlot/
  // commission/epoch fully pin the reward and are immutable for a past epoch.
  const rewards = (Array.isArray(response) ? response : []).map((e) =>
    e == null
      ? null
      : {
          epoch: e.epoch ?? null,
          effectiveSlot: e.effectiveSlot ?? null,
          amount: e.amount ?? null,
          commission: e.commission ?? null,
        },
  );
  const shape = { rewards };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveInflationRewardChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetInflationRewardParams; bucket: GetInflationRewardBucket } | null> {
  let epoch: number;
  try {
    const info = await ctx.utility.call<{ epoch?: number }>("getEpochInfo", [
      { commitment: "finalized" },
    ]);
    if (typeof info?.epoch !== "number" || info.epoch < 1) return null;
    epoch = info.epoch - 1; // previous (completed) epoch
  } catch {
    return null;
  }

  let addresses: string[];
  try {
    const va = await ctx.utility.call<VoteAccountsResponse>("getVoteAccounts", [
      { commitment: "finalized", keepUnstakedDelinquents: false },
    ]);
    addresses = (va?.current ?? [])
      .map((v) => v.votePubkey)
      .filter((s): s is string => typeof s === "string")
      .slice(0, ADDR_COUNT);
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;

  return { params: { addresses, options: { epoch } }, bucket: "prev_epoch" };
}

export const handlers: MethodHandlers<GetInflationRewardParams, GetInflationRewardResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveInflationRewardChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
