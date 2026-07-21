/**
 * isBlockhashValid — Archetype E (boolean, byte-equal).
 *
 * Returns `{ context, value: boolean }` — whether a blockhash is still valid
 * (within the ~150-slot window). Two buckets:
 *   - "valid":   a blockhash freshly fetched from the utility endpoint at derivation. It
 *     stays valid for ~150 slots (~60s) > the 30s TTL, so it is solidly `true`
 *     when the workers run.
 *   - "invalid": a syntactically-valid base58-32 string that is never a real
 *     recent blockhash (all-zero 32 bytes) → `false`.
 * Project `{ valid }`; byte-equal consensus.
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

export const BUCKETS = ["valid", "invalid"] as const;
export type IsBlockhashValidBucket = (typeof BUCKETS)[number];

/** base58 of 32 zero-bytes — a well-formed pubkey, never a recent blockhash. */
const NEVER_VALID_BLOCKHASH = "11111111111111111111111111111111";

export interface IsBlockhashValidParams {
  blockhash: string;
  options: { commitment: "finalized" };
}

interface IsBlockhashValidResponse {
  context?: { slot?: number };
  value?: boolean;
}

function projectImpl(response: IsBlockhashValidResponse): CanonicalProjection {
  const shape = { valid: typeof response?.value === "boolean" ? response.value : null };
  return { hash: hashProjection(canonicalize(shape)), shape };
}

export async function deriveIsBlockhashValidChallenge(
  ctx: ChallengeContext,
  bucket: IsBlockhashValidBucket,
): Promise<{ params: IsBlockhashValidParams; bucket: IsBlockhashValidBucket } | null> {
  if (bucket === "invalid") {
    return {
      params: { blockhash: NEVER_VALID_BLOCKHASH, options: { commitment: "finalized" } },
      bucket,
    };
  }
  // valid: fetch a fresh blockhash from the utility endpoint.
  try {
    const res = await ctx.utility.call<{ value?: { blockhash?: string } }>("getLatestBlockhash", [
      { commitment: "finalized" },
    ]);
    const blockhash = res?.value?.blockhash;
    if (typeof blockhash !== "string") return null;
    return { params: { blockhash, options: { commitment: "finalized" } }, bucket };
  } catch {
    return null;
  }
}

export const handlers: MethodHandlers<IsBlockhashValidParams, IsBlockhashValidResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveIsBlockhashValidChallenge(ctx, ctx.bucket as IsBlockhashValidBucket);
  },
  project: projectImpl,
  classify(projection, reference): Correctness {
    return byteEqualHash(projection, reference) ? "correct" : "incorrect";
  },
};
