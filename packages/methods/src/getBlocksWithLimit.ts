/**
 * getBlocksWithLimit — Archetype A (deterministic byte-equal).
 *
 * Near-clone of getBlocks: returns up to `limit` confirmed block slots starting
 * at `startSlot`. Over a finalized range the produced-slot set is immutable, so
 * every provider returns the identical list. We pin a finalized start slot and a
 * small fixed limit.
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
import { pickFinalizedSlot } from "./probe.js";

export const BUCKETS = ["recent_finalized", "archival"] as const;
export type GetBlocksWithLimitBucket = (typeof BUCKETS)[number];

/** Number of blocks to request — small enough to stay under RPC range limits. */
const LIMIT = 20;

export interface GetBlocksWithLimitParams {
  startSlot: number;
  limit: number;
}

type GetBlocksWithLimitResponse = number[];

function projectImpl(response: GetBlocksWithLimitResponse): CanonicalProjection {
  const slots = Array.isArray(response)
    ? [...response].filter((s) => typeof s === "number").sort((a, b) => a - b)
    : [];
  const shape = { slots };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveBlocksWithLimitChallenge(
  ctx: ChallengeContext,
  bucket: GetBlocksWithLimitBucket,
): Promise<{ params: GetBlocksWithLimitParams; bucket: GetBlocksWithLimitBucket } | null> {
  const start = pickFinalizedSlot(ctx, bucket);
  if (start === null) return null;
  return { params: { startSlot: Number(start), limit: LIMIT }, bucket };
}

export const handlers: MethodHandlers<GetBlocksWithLimitParams, GetBlocksWithLimitResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveBlocksWithLimitChallenge(ctx, ctx.bucket as GetBlocksWithLimitBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
