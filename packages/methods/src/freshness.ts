/**
 * Slot / freshness helpers shared by the context-wrapped methods (responses
 * shaped `{context:{slot}, value:…}`). The `slot` each provider returns is its
 * observed tip for the read — the cross-provider-comparable freshness signal
 * for time-advancing scalars and the Hybrid value methods' liveness fallback.
 *
 * The tolerance is a tight CONSENSUS window (the panel is queried in parallel).
 */

import { type CanonicalProjection, type Correctness } from "@rpcbench/shared";

/**
 * Tight consensus tolerance — 4 slots ≈ 1.6s of chain progress.
 * getSlot.ts declares its own SLOT_TOLERANCE with the same value: that one
 * also feeds getSlot's answer-equivalence check, so the two are kept as
 * separate knobs deliberately — retune them together unless you mean to split.
 */
export const SLOT_TOLERANCE = 4;
/**
 * Stale-tip guard shared by every mutable-state method's classify: a provider
 * whose returned context.slot lags the reference tip by more than this many
 * slots answered from a stale view (scored "stale"), even when the projected
 * value hashes equal. BigInt because tip slots are compared as bigints.
 */
export const STALE_TIP_LAG_SLOTS = 2n;

/** Extract `context.slot` from a context-wrapped RPC result, or null. */
export function contextSlot(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const ctx = (result as { context?: { slot?: unknown } }).context;
  const s = ctx?.slot;
  return typeof s === "number" ? s : null;
}

/** Read the `slot` carried in a projection shape, or null. */
export function slotFromShape(shape: unknown): number | null {
  if (!shape || typeof shape !== "object") return null;
  const s = (shape as { slot?: unknown }).slot;
  return typeof s === "number" ? s : null;
}

/**
 * getSlot-style freshness verdict on a method's OWN returned slot (from the
 * projection shape) against the reference tip. A provider that isn't behind the
 * reference tip by more than `tolerance` is `correct`; one that lags is `stale`;
 * a missing/malformed slot is `incorrect`.
 *
 * Note `referenceTipSlot === 0n` (tip-capture piggyback failed) degenerates to
 * `returned >= -tolerance` → always `correct`: a safe fail-open consistent with
 * freshness being a liveness signal, matching getSlot.classify.
 */
export function freshnessVerdict(
  projection: CanonicalProjection,
  referenceTipSlot: bigint,
  tolerance: number = SLOT_TOLERANCE,
): Correctness {
  const returned = slotFromShape(projection.shape);
  if (returned === null) return "incorrect";
  if (BigInt(returned) >= referenceTipSlot - BigInt(tolerance)) return "correct";
  return "stale";
}

/**
 * Numeric-tolerance helpers for the VALUE-TOLERANCE scalars (getBlockHeight,
 * getTransactionCount). Unlike the slot helpers above, the carried number is a
 * block height / tx counter — NOT a slot — so it cannot be compared against
 * `referenceTipSlot`. Consensus compares two providers' values within a
 * tolerance; `classify` compares a provider's value against the consensus
 * reference value (monotonic: at-or-ahead is `correct`, behind by > tol is
 * `stale`). The carried field is `shape.value`.
 */
export function valueFromShape(shape: unknown): number | null {
  if (!shape || typeof shape !== "object") return null;
  const v = (shape as { value?: unknown }).value;
  return typeof v === "number" ? v : null;
}

/** Match predicate factory: two projections agree if their values are within `tol`. */
export function valueWithin(
  tol: number,
): (a: CanonicalProjection, b: CanonicalProjection) => boolean {
  return (a, b) => {
    const va = valueFromShape(a.shape);
    const vb = valueFromShape(b.shape);
    if (va === null || vb === null) return false;
    return Math.abs(va - vb) <= tol;
  };
}

/**
 * Verdict for a value-tolerance scalar against the CONSENSUS reference value.
 * `correct` when at-or-ahead of (reference − tol); `stale` when behind by more;
 * `incorrect` when the value is missing/malformed. Monotonic counters that read
 * ahead of the reference are legitimately fresher, so they stay `correct`.
 */
export function valueVerdict(
  projection: CanonicalProjection,
  reference: CanonicalProjection,
  tol: number,
): Correctness {
  const v = valueFromShape(projection.shape);
  if (v === null) return "incorrect";
  const r = valueFromShape(reference.shape);
  if (r === null) return "correct"; // no reference value → fail-open (liveness)
  if (v >= r - tol) return "correct";
  return "stale";
}
