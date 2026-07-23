/**
 * getClusterNodes — Archetype C (set similarity / Jaccard on node pubkeys),
 * WITH a well-formedness fallback.
 *
 * Returns the cluster's gossip node set (~thousands of entries). The set is
 * broadly stable, BUT each provider reports its OWN gossip view: propagation
 * lag and recently joined/left validators make the views differ at the edges —
 * the same failure mode that pushed getRecentPerformanceSamples off a planned
 * Jaccard approach (maj=1) and onto well-formedness.
 *
 * So both projections live here and the committed one is chosen from live
 * dry-run convergence (see docs/methodology.md):
 *   - Jaccard path (USE_JACCARD = true): project the SET of node pubkeys and
 *     compare via `jaccardAtLeast` at CLUSTER_NODES_JACCARD_THRESHOLD. Requires
 *     wiring `clusterNodesProjectionsMatch` into record.ts.
 *   - Well-formedness path (USE_JACCARD = false): project a boolean — a
 *     non-empty array whose entries each carry a base58-32 `pubkey`. Serving
 *     providers all hash `true` → byte-equal consensus → correct. No record.ts
 *     wiring needed.
 *
 * Flip USE_JACCARD if the dry-run shows the Jaccard set doesn't reach a
 * 3-voter majority.
 */

import {
  byteEqualHash,
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
  buffersEqual,
} from "@rpcbench/shared";
import { isBase58_32 } from "./wellformed.js";
import { jaccardAtLeast } from "./setsim.js";

export const BUCKETS = ["default"] as const;
/**
 * Committed scoring family. A Jaccard path over the node set rarely reaches a
 * 3-voter majority: the pre-Chainstack 4-provider panel served ~4576 nodes each
 * (counts within 7), but the gossip views diverge / churn enough that the large
 * sets don't converge at 0.8 — the same failure mode as
 * getRecentPerformanceSamples. So the committed family is the well-formedness
 * fallback: all serving providers hash `true` → byte-equal consensus.
 * Chainstack's gossip node count/behavior for this method hasn't been
 * dry-run-measured yet — re-validate against the full 5-provider panel before
 * flipping USE_JACCARD.
 */
const USE_JACCARD = false;

/**
 * Jaccard overlap threshold for two gossip node-pubkey sets to be considered
 * equal. ~0.8 tolerates the gossip-edge churn on a large, mostly-stable set.
 */
export const CLUSTER_NODES_JACCARD_THRESHOLD = 0.8;

export type GetClusterNodesParams = Record<string, never>;

interface ClusterNode {
  pubkey?: string;
}
type GetClusterNodesResponse = ClusterNode[];

function pubkeysFromShape(shape: unknown): string[] | null {
  if (!shape || typeof shape !== "object") return null;
  const a = (shape as { pubkeys?: unknown }).pubkeys;
  if (!Array.isArray(a)) return null;
  return a.filter((x): x is string => typeof x === "string");
}

function projectImpl(response: GetClusterNodesResponse): CanonicalProjection {
  if (USE_JACCARD) {
    const pubkeys = (Array.isArray(response) ? response : [])
      .map((n) => (typeof n?.pubkey === "string" ? n.pubkey : ""))
      .filter((s) => s.length > 0)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const shape = { pubkeys };
    return { hash: hashProjection(canonicalize(shape)), shape };
  }
  // Well-formedness fallback.
  const wellFormed =
    Array.isArray(response) && response.length > 0 && response.every((n) => isBase58_32(n?.pubkey));
  const shape = { wellFormed };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

/** Consensus match: Jaccard over the node-pubkey sets (Jaccard path only). */
export function clusterNodesProjectionsMatch(a: CanonicalProjection, b: CanonicalProjection): boolean {
  if (buffersEqual(a.hash, b.hash)) return true;
  const aa = pubkeysFromShape(a.shape);
  const bb = pubkeysFromShape(b.shape);
  if (!aa || !bb) return false;
  return jaccardAtLeast(new Set(aa), new Set(bb), CLUSTER_NODES_JACCARD_THRESHOLD);
}

export const handlers: MethodHandlers<GetClusterNodesParams, GetClusterNodesResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return { params: {}, bucket: ctx.bucket };
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    if (!USE_JACCARD) {
      return byteEqualHash(projection, reference) ? "correct" : "incorrect";
    }
    const matches =
      reference.shape != null
        ? clusterNodesProjectionsMatch(projection, reference)
        : buffersEqual(projection.hash, reference.hash);
    return matches ? "correct" : "incorrect";
  },
};

