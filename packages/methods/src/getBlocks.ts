/**
 * getBlocks — Archetype A (deterministic byte-equal).
 *
 * Returns the list of confirmed block slots in `[startSlot, endSlot]`. Over a
 * finalized range the produced-slot set is immutable, so every provider returns
 * the identical list. We pin a finalized start slot and a small fixed window.
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
export type GetBlocksBucket = (typeof BUCKETS)[number];

/** Window size (slots) — small enough to stay well under RPC range limits. */
const WINDOW = 20;

export interface GetBlocksParams {
  startSlot: number;
  endSlot: number;
}

type GetBlocksResponse = number[];

function projectImpl(response: GetBlocksResponse): CanonicalProjection {
  const slots = Array.isArray(response)
    ? [...response].filter((s) => typeof s === "number").sort((a, b) => a - b)
    : [];
  const shape = { slots };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveBlocksChallenge(
  ctx: ChallengeContext,
  bucket: GetBlocksBucket,
): Promise<{ params: GetBlocksParams; bucket: GetBlocksBucket } | null> {
  const start = pickFinalizedSlot(ctx, bucket);
  if (start === null) return null;
  return {
    params: { startSlot: Number(start), endSlot: Number(start) + WINDOW },
    bucket,
  };
}

export const handlers: MethodHandlers<GetBlocksParams, GetBlocksResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveBlocksChallenge(ctx, ctx.bucket as GetBlocksBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
