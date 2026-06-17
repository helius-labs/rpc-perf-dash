/**
 * getGenesisHash — Archetype A (deterministic byte-equal).
 *
 * Returns the network's genesis hash, a base58-32 constant identical for every
 * mainnet node forever. No input. Byte-equal consensus + auditor (default
 * predicate in record.ts); any divergence is a genuinely wrong/forked node.
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

export const BUCKETS = ["default"] as const;
export type GetGenesisHashBucket = (typeof BUCKETS)[number];

export type GetGenesisHashParams = Record<string, never>;

type GetGenesisHashResponse = string;

function projectImpl(response: GetGenesisHashResponse): CanonicalProjection {
  const shape = { genesisHash: typeof response === "string" ? response : null };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetGenesisHashParams, GetGenesisHashResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
