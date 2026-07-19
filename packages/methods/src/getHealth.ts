/**
 * getHealth — Archetype E (boolean health).
 *
 * Returns the string "ok" when the node is healthy. An UNHEALTHY node returns a
 * JSON-RPC error (e.g. -32005, no `result`), which the runner's projectResponse
 * already classifies as `rpc_error` → non-voter on the RELIABILITY axis — it
 * never reaches `project()`. So in practice every serving voter projects
 * `{ ok:true }` and forms byte-equal consensus; the method primarily measures
 * availability/reliability. The `false` branch is a harmless guard for a
 * provider that returns a 200 with a non-"ok" body.
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
export type GetHealthParams = Record<string, never>;

type GetHealthResponse = string;

function projectImpl(response: GetHealthResponse): CanonicalProjection {
  const shape = { ok: response === "ok" };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export const handlers: MethodHandlers<GetHealthParams, GetHealthResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
