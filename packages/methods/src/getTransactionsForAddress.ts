/**
 * getTransactionsForAddress method handlers.
 *
 * Custom (non-standard) address-history method served compatibly by Helius,
 * Triton, and Alchemy. QuickNode serves a non-comparable variant (bare-array
 * result, always-full details, slot filter ignored — see its
 * `unsupported_methods` comment in packages/shared/src/providers.ts), so the
 * panel is 3 voters. On a structurally-3-voter panel the consensus floor is
 * lowered to a 2-1 strict majority (record.ts passes minGroup=2), so a lone
 * deviator — e.g. Triton's intermittent empty responses, observed live
 * 2026-06-12 — is scored `incorrect` rather than ambiguating the whole
 * challenge. See docs/methodology.md.
 *
 * Bucketing (2, both slot-pinned):
 *   sigs__desc__pinned__l1000 — transactionDetails: "signatures", limit 1000
 *   full__desc__pinned__l25   — transactionDetails: "full", limit 25
 *
 * Determinism design: instead of bridging finalized-semantics tip drift with
 * a Jaccard tolerance (the getSignaturesForAddress approach), every challenge
 * pins `filters: { slot: { lte: pin } }` with pin = tip − 5000 (~35 min,
 * deeply finalized) and sortOrder "desc". "The newest ≤limit txs at or before
 * `pin`" is an immutable answer: cross-camp drift lives at the tip, which the
 * pin excludes, and desc-over-pin keeps data recent so archival indexer-depth
 * divergence doesn't bite. Result: strict byte-equal projection for BOTH
 * modes (verified live 2026-06-12 — 3-provider byte-match on 12/12 sigs-mode
 * and 6/6 full-mode probes).
 *
 * The non-high activity filter in derivation is LOAD-BEARING for this method,
 * not just a payload-variance bound: vote-authority addresses (which classify
 * `high`) showed massive cross-provider divergence in live probing (vote-tx
 * indexing differs per provider). Filtering them out is what makes byte-equal
 * consensus possible. Don't relax it.
 *
 * Common-subset params only: no Helius-only `filters.tokenTransfer`, no
 * `processed` commitment, json encoding. Full-mode limit 25 is storage-driven
 * (~325KB reference_response measured at limit 25), not just latency-driven.
 *
 * Auditor caveat: the auditor reference fetch hits the utility endpoint,
 * which serves this custom method only under the current Helius-gatekeeper
 * stopgap (AUDITOR_PANEL_OVERLAP_OK=1). A future panel-independent auditor
 * likely won't serve it — every challenge then becomes `auditor_unavailable`
 * (soft: consensus-scored, flagged).
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { classifyActivity, collectSigners, type RecentBlock } from "./probe.js";

export const GTFA_SIGS_BUCKET = "sigs__desc__pinned__l1000";
export const GTFA_FULL_BUCKET = "full__desc__pinned__l25";

export const BUCKETS = [GTFA_SIGS_BUCKET, GTFA_FULL_BUCKET];

const SIGS_LIMIT = 1000;
const FULL_LIMIT = 25;

/**
 * Pin distance behind tip: ~35 min at ~2.5 slots/s — deeply finalized for
 * every provider camp, recent enough that no answer depends on archive depth.
 */
export const GTFA_PIN_OFFSET_SLOTS = 5000n;

export interface GtfaParams {
  address: string;
  options: {
    transactionDetails: "signatures" | "full";
    sortOrder: "desc";
    limit: number;
    commitment: "finalized";
    filters: { slot: { lte: number } };
    /** Full mode only. */
    encoding?: "json";
    /** Full mode only. */
    maxSupportedTransactionVersion?: 0;
  };
}

interface GtfaSigEntry {
  signature: string;
  slot: number;
  transactionIndex?: number;
  err: unknown;
  memo?: string | null;
  blockTime?: number | null;
  confirmationStatus?: string | null;
}

interface GtfaFullEntry {
  slot: number;
  transactionIndex?: number;
  blockTime?: number | null;
  transaction: { signatures: string[] };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
  } | null;
}

interface GtfaResponse {
  data: Array<GtfaSigEntry | GtfaFullEntry>;
  paginationToken?: string | null;
}

// Belt-and-braces: the shape below is built from picked fields, but drop the
// known-drifty keys anyway in case an entry leaks through canonicalize whole.
// `transactionIndex` stays out of the hash until vote-tx counting parity is
// verified live across providers (indexers may count vote txs differently);
// `paginationToken` is a provider-internal cursor.
const DROP_KEYS = new Set([
  "blockTime",
  "memo",
  "confirmationStatus",
  "transactionIndex",
  "paginationToken",
]);

function isFullEntry(e: GtfaSigEntry | GtfaFullEntry): e is GtfaFullEntry {
  return typeof (e as GtfaFullEntry).transaction === "object" &&
    (e as GtfaFullEntry).transaction !== null;
}

function bySlotThenSignature(
  a: { slot: number; signature: string },
  b: { slot: number; signature: string },
): number {
  if (a.slot !== b.slot) return a.slot - b.slot;
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
}

/**
 * Mode is detected structurally (entries don't echo `transactionDetails`):
 * an entry carrying a `transaction` object is full mode. An empty `data`
 * projects as the sigs shape — deterministic across providers either way,
 * and under a pin empty-vs-nonempty is a real divergence, not noise.
 */
function projectImpl(response: GtfaResponse): CanonicalProjection {
  const entries = Array.isArray(response?.data) ? response.data : [];

  let shape: unknown;
  if (entries.length > 0 && isFullEntry(entries[0]!)) {
    shape = {
      kind: "full",
      txs: entries
        .filter(isFullEntry)
        .map((e) => ({
          signature: e.transaction.signatures[0] ?? "",
          slot: e.slot,
          err: e.meta?.err ?? null,
          fee: e.meta?.fee ?? null,
          preBalances: e.meta?.preBalances ?? null,
          postBalances: e.meta?.postBalances ?? null,
        }))
        .sort(bySlotThenSignature),
    };
  } else {
    shape = {
      kind: "sigs",
      sigs: (entries as GtfaSigEntry[])
        .map((e) => ({
          signature: e.signature,
          slot: e.slot,
          err: e.err ?? null,
        }))
        .sort(bySlotThenSignature),
    };
  }
  const json = canonicalize(shape, { dropKeys: DROP_KEYS });
  return { hash: hashProjection(json), shape };
}

function optionsForBucket(bucket: string, pin: number): GtfaParams["options"] {
  if (bucket === GTFA_FULL_BUCKET) {
    return {
      transactionDetails: "full",
      sortOrder: "desc",
      limit: FULL_LIMIT,
      commitment: "finalized",
      filters: { slot: { lte: pin } },
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    };
  }
  return {
    transactionDetails: "signatures",
    sortOrder: "desc",
    limit: SIGS_LIMIT,
    commitment: "finalized",
    filters: { slot: { lte: pin } },
  };
}

export async function deriveGtfaChallenge(
  ctx: ChallengeContext,
  bucket: string,
): Promise<{ params: GtfaParams; bucket: string } | null> {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip <= GTFA_PIN_OFFSET_SLOTS) return null;
  const pin = tip - GTFA_PIN_OFFSET_SLOTS;

  // Probe a random block strictly BELOW the pin: every signer harvested from
  // it has ≥1 tx inside the `slot <= pin` filter window by construction, so
  // empty-answer challenges are rare.
  const probeSlot = pin - BigInt(1 + Math.floor(Math.random() * 9000));
  if (probeSlot <= 0n) return null;
  let block: RecentBlock;
  try {
    block = await ctx.utility.call<RecentBlock>("getBlock", [
      Number(probeSlot),
      {
        encoding: "json",
        transactionDetails: "accounts",
        maxSupportedTransactionVersion: 0,
        rewards: false,
      },
    ]);
  } catch {
    return null;
  }
  if (!block?.transactions?.length) return null;

  for (const addr of collectSigners(block, 100)) {
    // Load-bearing filter — see module header. High-activity addresses
    // (programs, vote authorities) diverge across providers' indexers.
    const activity = await classifyActivity(ctx, addr);
    if (activity === "high") continue;

    return {
      params: { address: addr, options: optionsForBucket(bucket, Number(pin)) },
      bucket,
    };
  }
  return null;
}

export const handlers: MethodHandlers<GtfaParams, GtfaResponse> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveGtfaChallenge(ctx, ctx.bucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot): Correctness {
    // Pinned challenges are immutable — strict byte-equal, no tolerance.
    if (!buffersEqual(projection.hash, reference.hash)) return "incorrect";
    if (referenceTipSlot - providerTipSlot > 2n) return "stale";
    return "correct";
  },
};

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
