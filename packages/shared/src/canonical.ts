import { createHash } from "node:crypto";

/**
 * Canonicalization rules for projection hashes.
 *
 * Rules (documented in methodology.md):
 * - Object keys sorted recursively.
 * - For sets (e.g. transaction account keys), sort and compare as sets.
 * - `null` and missing fields are treated equivalent for OPTIONAL fields.
 *   Required fields use a sentinel ("__missing__") that hash-distinguishes.
 * - For tx records inside getBlock, the whole record is kept together and
 *   sorted by primary signature — independent sort would break tx↔meta pairing.
 *
 * `response_hash` and `reference_hash` both run through the same projection
 * function per method, so equality is binary — no tolerance windows in the
 * hash itself. Tolerances live at classify time (e.g., set-intersection rule
 * for getSignaturesForAddress).
 */

const OPTIONAL_NULL_SENTINEL = "__optional_null__";

/**
 * Stable JSON canonicalization: sorts object keys recursively, drops keys
 * explicitly listed in `dropKeys`, and replaces null/undefined values for
 * keys in `optionalKeys` with a stable sentinel.
 */
export function canonicalize(
  value: unknown,
  opts: { dropKeys?: ReadonlySet<string>; optionalKeys?: ReadonlySet<string> } = {},
): string {
  const drop = opts.dropKeys ?? EMPTY_SET;
  const optional = opts.optionalKeys ?? EMPTY_SET;
  return JSON.stringify(canon(value, drop, optional));
}

function canon(
  value: unknown,
  drop: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => canon(v, drop, optional));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (drop.has(k)) continue;
    const v = obj[k];
    if ((v === null || v === undefined) && optional.has(k)) {
      out[k] = OPTIONAL_NULL_SENTINEL;
    } else {
      out[k] = canon(v, drop, optional);
    }
  }
  return out;
}

export function hashProjection(projection: string): Buffer {
  return createHash("sha256").update(projection, "utf8").digest();
}

const EMPTY_SET: ReadonlySet<string> = new Set();
