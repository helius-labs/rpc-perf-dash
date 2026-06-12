/**
 * getVersion — Archetype D (node-identity, well-formedness-only).
 *
 * Returns `{ "solana-core", "feature-set" }` — the node's software version and
 * feature-set, which legitimately differ across providers. Same mechanism as
 * getIdentity: project a BOOLEAN well-formedness verdict (has a string
 * `solana-core` and an integer `feature-set`) → byte-equal consensus. Measures
 * availability + well-formedness, not the version value.
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
export type GetVersionBucket = (typeof BUCKETS)[number];

export interface GetVersionParams {}

interface GetVersionResponse {
  "solana-core"?: string;
  "feature-set"?: number;
}

function projectImpl(response: GetVersionResponse): CanonicalProjection {
  const wellFormed =
    typeof response?.["solana-core"] === "string" &&
    Number.isInteger(response?.["feature-set"]);
  const shape = { wellFormed };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetVersionParams, GetVersionResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
