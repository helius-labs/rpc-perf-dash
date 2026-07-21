/**
 * Shared SPL / system-program constants and account-layout helpers used by the
 * mutable-state account methods (getAccountInfo, getProgramAccounts,
 * getTokenAccountsByOwner).
 *
 * These methods read CURRENT MUTABLE STATE, so byte-equal cross-provider
 * consensus is unreachable for a changing account. The shared strategy is a
 * STRUCTURAL-ONLY projection: hash only the fields/byte-ranges that don't drift
 * across slots (owner, space, mint, account-owner, decimals, authorities) and
 * exclude the mutable balance (lamports; SPL token `amount`; mint `supply`).
 * See docs/methodology.md and the method files for the full rationale.
 */

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/**
 * Token-2022 (Token Extensions). Its *base* account and mint share the classic
 * layout (account 165 bytes with mint@0 / owner@32; mint 82 bytes), so
 * getProgramAccounts filtered on the base dataSize compares byte-for-byte the
 * same way SPL Token does. Extension accounts are larger and excluded by the
 * dataSize filter.
 */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Classic SPL token account size in bytes. */
export const SPL_TOKEN_ACCOUNT_SIZE = 165;
/** Classic SPL mint size in bytes. */
export const SPL_MINT_SIZE = 82;

/**
 * SPL token account layout (classic): mint [0,32), owner [32,64), amount [64,72),
 * … The first 64 bytes (mint + owner) are immutable for the life of the account;
 * `amount` at offset 64 drifts. The server-side `dataSlice {offset:0,length:64}`
 * used by getProgramAccounts / getTokenAccountsByOwner captures exactly the
 * structural prefix.
 */
export const TOKEN_ACCOUNT_STRUCTURAL_LEN = 64;

/**
 * Extract a base64 string from the `[<base64>, "base64"]` data tuple that
 * JSON-RPC returns. Returns "" for missing/empty data. Never returns the whole
 * tuple — hashing the tuple would let the encoding tag leak into the hash.
 */
export function dataString(data: unknown): string {
  if (Array.isArray(data)) {
    const first = data[0];
    return typeof first === "string" ? first : "";
  }
  // jsonParsed or unexpected shapes are not used by these methods; be defensive.
  return "";
}

/**
 * Structural data prefix for a single account, given its base64 data string,
 * owner, and space. Excludes every mutable byte range so the projection is
 * stable across slots:
 *   - token account (owner=Token, space=165): keep [0,64) (mint+owner).
 *   - mint          (owner=Token, space=82) : keep [0,36) (mint_authority) +
 *                                              [44,82) (decimals, is_initialized,
 *                                              freeze_authority); EXCLUDE the
 *                                              interior supply at [36,44).
 *   - everything else (wallet/system, program, unknown): "" — structural
 *     identity is carried by owner/space/executable, and we don't know which
 *     bytes are mutable for arbitrary account types, so hashing none is the
 *     safe choice.
 */
export function structuralDataPrefix(
  dataB64: string,
  owner: string,
  space: number,
): string {
  if (!dataB64) return "";
  if (owner !== TOKEN_PROGRAM_ID) return "";

  const bytes = Buffer.from(dataB64, "base64");
  if (space === SPL_TOKEN_ACCOUNT_SIZE) {
    return bytes.subarray(0, TOKEN_ACCOUNT_STRUCTURAL_LEN).toString("base64");
  }
  if (space === SPL_MINT_SIZE) {
    // Concatenate the two structural regions, dropping the interior supply
    // range [36,44). A simple prefix slice can't express this.
    const head = bytes.subarray(0, 36);
    const tail = bytes.subarray(44, 82);
    return Buffer.concat([head, tail]).toString("base64");
  }
  return "";
}
