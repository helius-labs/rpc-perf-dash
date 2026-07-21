import { createHash, createHmac } from "node:crypto";
import { canonicalize } from "@rpcbench/shared";

export function generateSeed(secret: string, slot: bigint, timestamp: number): Buffer {
  return createHmac("sha256", secret)
    .update(`${slot.toString()}:${timestamp.toString()}`)
    .digest();
}

/**
 * commitment = SHA-256(seed ‖ canonical-JSON(params)).
 *
 * canonical-JSON is the same recursively-key-sorted serialization used for
 * projection hashing (packages/shared/src/canonical.ts) — key order cannot
 * change the hash, so external verifiers don't need to reproduce the
 * generator's object-construction order. Challenges generated before this
 * change hashed insertion-order JSON.stringify(params) instead; recompute
 * those with that form (see docs/methodology.md § Verification).
 */
export function commitmentHash(seed: Buffer, params: unknown): Buffer {
  const paramsJson = canonicalize(params);
  return createHash("sha256")
    .update(seed)
    .update(paramsJson, "utf8")
    .digest();
}
