/**
 * Slot / freshness helpers shared by the context-wrapped methods (responses
 * shaped `{context:{slot}, value:…}`). The `slot` each provider returns is its
 * observed tip for the read — the cross-provider-comparable freshness signal
 * for time-advancing scalars and the Hybrid value methods' liveness fallback.
 *
 * Tolerances mirror getSlot.ts: a tight CONSENSUS window (panel queried in
 * parallel) and a wide AUDITOR window. The auditor is captured at challenge
 * generation (t=0) but the panel is measured at fanout (t+δ, δ up to the 30s
 * TTL), so the wider window absorbs that legitimate drift.
 */

import { byteEqualHash, type CanonicalProjection, type Correctness } from "@rpcbench/shared";

/** Tight consensus tolerance — 4 slots ≈ 1.6s of chain progress. */
export const SLOT_TOLERANCE = 4;
/** Wide auditor tolerance — 150 slots ≈ 60s, absorbs the t=0 → t+δ advance. */
export const SLOT_AUDITOR_TOLERANCE = 150;

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
 * `referenceTipSlot`. Consensus/auditor compare two providers' values within a
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

/**
 * Lenient AUDITOR predicate for the Hybrid value methods. Called as
 * `auditorMatch(consensusProjection, auditorProjection)` in record.ts. The
 * panel consensus (arg `a`) is captured at t+δ; the auditor (arg `b`) at t=0.
 * They "agree" if:
 *   - the value hash matches (account was stable across t=0 → t+δ), OR
 *   - the consensus slot is ≥ the auditor slot (panel at least as fresh ⇒ a
 *     value diff is legitimate forward drift, not a dispute).
 * This prevents in-window value drift from spuriously marking the panel
 * `consensus_disputed`, while a genuinely stale/garbled auditor still surfaces.
 */
export function valueOrFreshMatch(a: CanonicalProjection, b: CanonicalProjection): boolean {
  if (byteEqualHash(a, b)) return true;
  const ca = slotFromShape(a.shape);
  const cb = slotFromShape(b.shape);
  if (ca === null || cb === null) return false;
  return ca >= cb;
}
