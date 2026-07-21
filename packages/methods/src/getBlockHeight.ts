/**
 * getBlockHeight — Archetype B2 (value-tolerance scalar).
 *
 * Returns the current block height — a monotonically-advancing counter that is
 * NOT a slot (it skips empty slots), so it cannot reuse getSlot's slot
 * predicate or be compared against `referenceTipSlot`. Consensus groups
 * providers whose heights are within a tolerance; correctness compares a
 * provider's height against the consensus reference value (`valueVerdict`).
 * Predicates wired in record.ts.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { valueWithin, valueVerdict, valueFromShape } from "./freshness.js";

export const BUCKETS = ["processed", "confirmed", "finalized"] as const;
export type GetBlockHeightBucket = (typeof BUCKETS)[number];

/** Consensus tolerance (~4 blocks). */
export const HEIGHT_TOLERANCE = 4;

export interface GetBlockHeightParams {
  options: { commitment: GetBlockHeightBucket };
}

type GetBlockHeightResponse = number;

function projectImpl(response: GetBlockHeightResponse): CanonicalProjection {
  const value = typeof response === "number" ? response : null;
  const shape = { value };
  return { hash: hashProjection(canonicalize({ value })), shape };
}

export const blockHeightProjectionsMatch = valueWithin(HEIGHT_TOLERANCE);

export const handlers: MethodHandlers<GetBlockHeightParams, GetBlockHeightResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { options: { commitment: ctx.bucket as GetBlockHeightBucket } }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    if (valueFromShape(projection.shape) === null) return "incorrect";
    return valueVerdict(projection, reference, HEIGHT_TOLERANCE);
  },
};
