/**
 * getIdentity — Archetype D (node-identity, well-formedness-only).
 *
 * Returns `{ identity }` — the validator identity the RPC node fronts. This is
 * node-specific and legitimately differs across providers, so there is NO
 * cross-provider value correctness to check. Instead we project a BOOLEAN
 * well-formedness verdict (like getHealth): well-formed → hash of
 * `{ wellFormed:true }`; malformed-but-200 → hash of `{ wellFormed:false }`.
 * Serving providers all hash the same `true` constant → byte-equal consensus →
 * correct; a malformed response dissents and scores `incorrect` on the
 * correctness axis. `project()` ALWAYS returns a projection (it is non-nullable;
 * the runner dereferences `.hash` unguarded). This measures availability +
 * well-formedness, not the identity value — see the methodology caveat.
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
import { isBase58_32 } from "./wellformed.js";

export const BUCKETS = ["default"] as const;
export type GetIdentityParams = Record<string, never>;

// Standard Solana returns `{ identity }`; the Helius gatekeeper returns the
// identity as a BARE string. Accept either shape.
type GetIdentityResponse = { identity?: string } | string;

function projectImpl(response: GetIdentityResponse): CanonicalProjection {
  const identity = typeof response === "string" ? response : response?.identity;
  const wellFormed = isBase58_32(identity);
  const shape = { wellFormed };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetIdentityParams, GetIdentityResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
