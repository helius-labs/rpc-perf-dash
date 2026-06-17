/**
 * getMultipleAccounts — mutable-structural byte-equal (Archetype Z, like
 * getAccountInfo).
 *
 * Batch sibling of getAccountInfo: returns an array of account values for N
 * pubkeys. Same correctness problem (current mutable state ⇒ no byte-equal over
 * balances) and same solution: project each account STRUCTURALLY (owner,
 * executable, space, type-aware data prefix) and EXCLUDE the mutable lamports.
 * The per-account shapes are kept in input order so the batch hash is stable.
 *
 * Input: the first few account keys from a recent block (any type — wallets,
 * programs, token accounts mixed). One bucket: the structural projection is the
 * honest cross-provider signal regardless of the account-type mix.
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
import { dataString, structuralDataPrefix } from "./spl.js";
import { recentBlock, collectAccountKeys } from "./probe.js";

export const BUCKETS = ["recent_block"] as const;
export type GetMultipleAccountsBucket = (typeof BUCKETS)[number];

/** Number of pubkeys per batch challenge. */
const N = 5;

export interface GetMultipleAccountsParams {
  pubkeys: string[];
  options: { encoding: "base64"; commitment: "finalized" };
}

interface AccountValue {
  lamports: number;
  owner: string;
  data: [string, string] | unknown;
  executable: boolean;
  space?: number;
}
interface GetMultipleAccountsResponse {
  context?: { slot?: number };
  value: Array<AccountValue | null>;
}

const OPTIONS: GetMultipleAccountsParams["options"] = { encoding: "base64", commitment: "finalized" };

/** Structural-only per-account shape — drops the mutable balance, like getAccountInfo. */
function accountShape(value: AccountValue | null): unknown {
  if (value === null) return { exists: false };
  const space = value.space ?? 0;
  return {
    exists: true,
    owner: value.owner,
    executable: value.executable,
    space,
    dataPrefix: structuralDataPrefix(dataString(value.data), value.owner, space),
  };
}

function projectImpl(response: GetMultipleAccountsResponse): CanonicalProjection {
  const accounts = Array.isArray(response?.value) ? response.value.map(accountShape) : [];
  const shape = { accounts };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveMultipleAccountsChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetMultipleAccountsParams; bucket: GetMultipleAccountsBucket } | null> {
  const block = await recentBlock(ctx);
  if (!block) return null;
  const keys = collectAccountKeys(block).slice(0, N);
  if (keys.length === 0) return null;
  return { params: { pubkeys: keys, options: OPTIONS }, bucket: "recent_block" };
}

export const handlers: MethodHandlers<GetMultipleAccountsParams, GetMultipleAccountsResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveMultipleAccountsChallenge(ctx);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    if (buffersEqual(projection.hash, reference.hash)) {
      if (referenceTipSlot - providerTipSlot > 2n) return "stale";
      return "correct";
    }
    // Mutable-state reorder: a provider that observed a NEWER slot than the
    // reference is fresh-but-divergent → stale, not incorrect.
    if (providerTipSlot > referenceTipSlot) return "stale";
    return "incorrect";
  },
};

