/**
 * getTransactionCount — Archetype B2 (value-tolerance scalar).
 *
 * Returns the cumulative transaction count — a monotonic counter advancing
 * ~thousands/sec, so it needs a much wider tolerance than a slot/height. Like
 * getBlockHeight it is compared by value tolerance (consensus/auditor) and
 * `valueVerdict` (correctness), wired in record.ts.
 *
 * ⚠️ The tolerances below are an INITIAL estimate. They MUST be tuned against
 * the measured inter-provider spread (see docs/methodology.md / the plan's
 * verification step) before reading the correctness number — too tight and
 * honest jitter dissents; too wide and a genuinely-behind provider scores
 * correct.
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
export type GetTransactionCountBucket = (typeof BUCKETS)[number];

/** INITIAL estimate — tune from live spread. ~thousands tx/s over the t+δ window. */
export const TXCOUNT_TOLERANCE = 25_000;
export const TXCOUNT_AUDITOR_TOLERANCE = 2_000_000;

export interface GetTransactionCountParams {
  options: { commitment: GetTransactionCountBucket };
}

type GetTransactionCountResponse = number;

function projectImpl(response: GetTransactionCountResponse): CanonicalProjection {
  const value = typeof response === "number" ? response : null;
  const shape = { value };
  return { hash: hashProjection(canonicalize({ value })), shape };
}

export const txCountProjectionsMatch = valueWithin(TXCOUNT_TOLERANCE);
export const txCountProjectionsMatchAuditor = valueWithin(TXCOUNT_AUDITOR_TOLERANCE);

export const handlers: MethodHandlers<GetTransactionCountParams, GetTransactionCountResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: { options: { commitment: ctx.bucket as GetTransactionCountBucket } }, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    if (valueFromShape(projection.shape) === null) return "incorrect";
    return valueVerdict(projection, reference, TXCOUNT_TOLERANCE);
  },
};
