/**
 * getBalance method handlers — HYBRID value method.
 *
 * getBalance returns a single mutable scalar: `{ context:{slot}, value:<lamports> }`.
 * Standard JSON-RPC has no slot-pinned read, so two honest providers measured a
 * few slots apart can legitimately report different lamports for any account
 * that moved in the window. There is no immutable structural field to fall back
 * on (unlike getAccountInfo, which drops lamports and hashes owner/space).
 *
 * Strategy (see docs/methodology.md, "Hybrid value methods"):
 *   - project hashes ONLY the lamports value, so the default byte-equal
 *     consensus predicate groups voters by balance. A ≥3-voter value-majority
 *     means the account was stable across the parallel panel reads → the value
 *     is verified (`classify` below, with mutable-state stale-reorder).
 *   - when NO value-majority forms (the account churned in-window), the runner
 *     falls back to `livenessFallback` — a freshness verdict on the returned
 *     slot — instead of dropping the samples as no_consensus. See
 *     packages/runner/src/record.ts.
 *   - the AUDITOR cross-check uses the lenient `valueOrFreshMatch` predicate
 *     (wired in record.ts) so in-window drift between the t=0 auditor reference
 *     and the t+δ panel doesn't spuriously mark the panel consensus_disputed.
 *
 * What it measures: the lamports value WHEN the panel agrees; otherwise a
 * liveness signal. Never an invented exact-balance check on a moving account.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { contextSlot, freshnessVerdict } from "./freshness.js";
import { recentBlock, collectSigners } from "./probe.js";

export const BUCKETS = ["wallet", "nonexistent"] as const;
export type GetBalanceBucket = (typeof BUCKETS)[number];

export interface GetBalanceParams {
  pubkey: string;
  options: { commitment: "finalized" };
}

// getBalance's RPC result is context-wrapped; value is the bare lamports number.
interface GetBalanceResponse {
  context?: { slot?: number };
  value: number | null;
}

const OPTIONS: GetBalanceParams["options"] = { commitment: "finalized" };

function projectImpl(response: GetBalanceResponse): CanonicalProjection {
  const slot = contextSlot(response);
  const lamports = typeof response?.value === "number" ? response.value : 0;
  // Hash the VALUE only; slot rides in shape for the freshness/auditor checks.
  const hash = hashProjection(canonicalize({ lamports }));
  return { hash, shape: { slot, lamports } };
}

export async function deriveBalanceChallenge(
  ctx: ChallengeContext,
  bucket: GetBalanceBucket,
): Promise<{ params: GetBalanceParams; bucket: GetBalanceBucket } | null> {
  const block = await recentBlock(ctx);
  if (!block) return null;

  // A blockhash is a base58 32-byte value that virtually never maps to a real
  // account — getBalance returns value:0 for it (same trick as getAccountInfo's
  // nonexistent bucket).
  if (bucket === "nonexistent") {
    const hash = block.blockhash;
    if (!hash) return null;
    return { params: { pubkey: hash, options: OPTIONS }, bucket };
  }

  // wallet: any transaction signer is a real, fundable account.
  const signers = collectSigners(block);
  const pubkey = signers[0];
  if (!pubkey) return null;
  return { params: { pubkey, options: OPTIONS }, bucket };
}

export const handlers: MethodHandlers<GetBalanceParams, GetBalanceResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveBalanceChallenge(ctx, ctx.bucket as GetBalanceBucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    // Value tier: byte-equal on the lamports hash, with mutable-state
    // stale-reorder (a hash-mismatch at a NEWER tip is fresh-but-divergent).
    if (buffersEqual(projection.hash, reference.hash)) {
      if (referenceTipSlot - providerTipSlot > 2n) return "stale";
      return "correct";
    }
    if (providerTipSlot > referenceTipSlot) return "stale";
    return "incorrect";
  },
  livenessFallback(projection, referenceTipSlot): Correctness {
    return freshnessVerdict(projection, referenceTipSlot);
  },
};

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
