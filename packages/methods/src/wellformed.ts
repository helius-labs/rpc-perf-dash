/**
 * Shared well-formedness primitives.
 *
 * `BASE58_32` is the shape gate for base58-encoded 32-byte values (pubkeys,
 * blockhashes, validator identities, leader pubkeys). Defined once here and
 * reused by getLatestBlockhash, getIdentity, getSlotLeader, isBlockhashValid.
 */

/** base58 alphabet (no 0, O, I, l); a 32-byte pubkey/blockhash is 32–44 chars. */
export const BASE58_32 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True iff `s` is a base58-encoded 32-byte value. */
export function isBase58_32(s: unknown): s is string {
  return typeof s === "string" && BASE58_32.test(s);
}
