/**
 * Normalize non-deterministic transaction-error serialization before hashing.
 *
 * Solana's `InstructionError::BorshIoError` variant is rendered two ways across
 * RPC providers / Agave versions:
 *   - legacy data form:  {"InstructionError":[i,{"BorshIoError":"Unknown"}]}
 *   - current unit form: {"InstructionError":[i,"BorshIoError"]}
 * The two are functionally identical (the string payload is a non-deterministic,
 * now-dropped IO message), but the getBlock/getTransaction/… projections hash the
 * `err` byte-for-byte, so a provider a version behind reads as a false
 * `data_mismatch`.
 *
 * `normalizeTxErr` collapses the object form `{"BorshIoError": <anything>}` to the
 * unit string `"BorshIoError"`, recursively (the variant appears nested inside the
 * `InstructionError` tuple, and errs can nest further). Everything else is
 * preserved verbatim — including meaningful data variants like `{"Custom": 6001}`
 * — so only this one known-nondeterministic variant is affected.
 */
export function normalizeTxErr(err: unknown): unknown {
  if (err === null || err === undefined) return null;
  if (typeof err !== "object") return err;
  if (Array.isArray(err)) return err.map(normalizeTxErr);
  const obj = err as Record<string, unknown>;
  const keys = Object.keys(obj);
  // Single-key `{BorshIoError: <string|anything>}` → the unit-variant string form.
  if (keys.length === 1 && keys[0] === "BorshIoError") return "BorshIoError";
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = normalizeTxErr(obj[k]);
  return out;
}
