/**
 * getSignaturesForAddress method handlers.
 *
 * Bucketing matrix (pruned to cross-camp-agreeable combos — see
 * docs/methodology.md § Consensus decision rules):
 *   activity:     medium | low                — drop `high` (tip-active addresses, camp tip drift dominates)
 *   address_type: program | token_account | user_wallet
 *   cursor:       latest                      — drop `shallow`/`deep`/`window` (anchor sig leaks Camp A semantics into Camp B queries)
 *   limit:        1000                        — drop `10`/`100` (too few sigs; tip drift > overlap)
 *
 * Plus one archival bucket outside the matrix: `archival__frozen__l100` — a
 * window pinned strictly `before` a 1–2-year-old anchor signature. Everything
 * before the anchor is immutable, so the tip-drift problem that forced the
 * cursor prune cannot occur; consensus for this bucket is strict byte-equal
 * (see classify) and it measures real archive depth, not caches.
 *
 * Yields 2 × 3 × 1 × 1 = 6 buckets. The full 3 × 3 × 4 × 3 = 108-bucket matrix
 * was structurally unmeasurable across the three "finalized" camps measured on
 * the v=1-era panel (Helius/Triton; Alchemy/QN/Flux; SF Public): >99% of
 * challenges went ambiguous because the
 * returned sig windows didn't overlap. The 6 retained buckets all share the
 * property that every camp returns essentially the same lifetime-tail list,
 * so the quorum reaches consensus and cross-camp worker comparisons land in
 * the same set.
 *
 * Projection: SET of returned signatures (sorted), each with slot, err,
 * confirmationStatus. Drops blockTime, memo, response order.
 *
 * Quorum tolerance: tip-anchored Jaccard ≥ 0.8 with full-set fallback; see
 * `sigsProjectionsMatch` below for the actual rule.
 */

import {
  canonicalize,
  hashProjection,
  type CanonicalProjection,
  type ChallengeContext,
  type Correctness,
  type MethodHandlers,
} from "@rpcbench/shared";
import { jaccardAtLeast } from "./setsim.js";
import { ARCHIVAL_UTILITY_TIMEOUT_MS, withArchivalSlotRetries } from "./probe.js";

const ACTIVITY = ["medium", "low"] as const;
const ADDRESS_TYPE = ["program", "token_account", "user_wallet"] as const;
const CURSOR = ["latest"] as const;
const LIMIT = ["1000"] as const;

/** Frozen deep-history window (1–2 years back); see header + classify. */
export const SIGS_ARCHIVAL_BUCKET = "archival__frozen__l100";
const SIGS_ARCHIVAL_LIMIT = 100;
/** Minimum sigs the pre-anchor window must hold for a non-degenerate challenge. */
const SIGS_ARCHIVAL_MIN_WINDOW = 5;

export const BUCKETS = [
  ...ACTIVITY.flatMap((act) =>
    ADDRESS_TYPE.flatMap((typ) =>
      CURSOR.flatMap((cur) => LIMIT.map((lim) => `${act}__${typ}__${cur}__l${lim}`)),
    ),
  ),
  SIGS_ARCHIVAL_BUCKET,
];

export interface GetSigsParams {
  address: string;
  options: {
    limit: number;
    before?: string;
    until?: string;
    commitment: "finalized";
  };
}

interface SigEntry {
  signature: string;
  slot: number;
  err: unknown;
  confirmationStatus?: string;
  blockTime?: number | null;
  memo?: string | null;
}

const DROP_KEYS = new Set(["blockTime", "memo"]);

/**
 * Anchor the projection on the older 80% of the returned list, dropping
 * the newest 20% (by slot) before hashing.
 *
 * Why: live multi-provider probing (on the v=1-era panel) showed two distinct
 * "finalized" semantics across the ecosystem. Helius / Helius Gatekeeper /
 * Triton returned identical lists. Alchemy / Flux / QuickNode returned lists
 * shifted ~30 slots (~12s) newer — they treated freshly-finalized signatures
 * as eligible sooner than the first group. SF Public sat in between with the
 * same set as the first group but a different order.
 *
 * The diff is real and worth surfacing as "data deviation," but it concentrates
 * at the tip of the returned list. Older entries are stable across every
 * provider that has retention for them. By trimming the newest 20% before
 * hashing, the strict byte-equal projection can reach consensus across
 * heterogeneous providers, while the per-provider raw_response is still
 * inspectable for the deviation analysis.
 *
 * Trade-off: small windows lose more relative coverage (limit=10 → 8 entries
 * hashed; limit=100 → 80; limit=1000 → 800). For limit=1 or tiny lists we
 * keep at least 1 entry rather than degenerating to nothing.
 *
 * INVARIANT (archival frozen-window bucket): the trim is a pure function of
 * the returned list — on a `before`-anchored immutable window every
 * archive-complete provider returns the identical list, trims identically,
 * and hashes identically, so the archival bucket's strict byte-equal
 * consensus works *through* this trim without any bucket-aware projection
 * plumbing. Don't make the trim depend on anything outside `response`.
 */
function projectImpl(response: SigEntry[]): CanonicalProjection {
  const sortedByAge = [...response].sort((a, b) => a.slot - b.slot);
  const keep = Math.max(1, Math.floor(sortedByAge.length * 0.8));
  const trimmed = sortedByAge.slice(0, keep);

  const shape = {
    sigs: trimmed
      .map((s) => ({
        signature: s.signature,
        slot: s.slot,
        err: s.err ?? null,
        confirmationStatus: s.confirmationStatus ?? "finalized",
      }))
      .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0)),
  };
  const json = canonicalize(shape, { dropKeys: DROP_KEYS });
  return { hash: hashProjection(json), shape };
}

// When `transactionDetails: "accounts"` is used, getBlock returns transactions
// without a `.message` wrapper — accountKeys live directly on `.transaction`.
// IMPORTANT: with transactionDetails="accounts", each entry is an *object*
// of shape { pubkey, signer, source, writable } — NOT a bare base58 string
// (that's what transactionDetails="full" returns). Use .pubkey on each.
interface AccountKeyEntry {
  pubkey: string;
  signer?: boolean;
  source?: string;
  writable?: boolean;
}
interface BlockKeysProbe {
  transactions: Array<{ transaction: { accountKeys?: AccountKeyEntry[]; signatures?: string[] } }>;
}

/**
 * Activity classification: query the utility endpoint for limit:100 sigs and
 * count how many land in the last hour. ≥50 → high, 1–49 → medium, 0 → low.
 *
 * Cached for 30 minutes per address to bound preflight cost.
 */
const activityCache = new Map<string, { activity: "high" | "medium" | "low"; expiresAt: number }>();

async function classifyActivity(
  ctx: ChallengeContext,
  address: string,
): Promise<"high" | "medium" | "low"> {
  const now = Date.now();
  const cached = activityCache.get(address);
  if (cached && cached.expiresAt > now) return cached.activity;

  let sigs: SigEntry[];
  try {
    sigs = await ctx.utility.call<SigEntry[]>("getSignaturesForAddress", [
      address,
      { limit: 100 },
    ]);
  } catch {
    return "low";
  }
  const oneHourAgo = (Date.now() / 1000) - 3600;
  const recent = sigs.filter((s) => (s.blockTime ?? 0) > oneHourAgo).length;
  const activity: "high" | "medium" | "low" =
    recent >= 50 ? "high" : recent >= 1 ? "medium" : "low";
  activityCache.set(address, { activity, expiresAt: now + 30 * 60 * 1000 });
  return activity;
}

/**
 * Archival derivation: harvest an anchor signature + signer address from a
 * 1–2-year-old block, then pin the challenge window strictly `before` the
 * anchor. The pre-check guarantees the window is non-degenerate (≥5 sigs) so
 * the reference is never empty/trivial. Activity classification is skipped —
 * last-hour activity is irrelevant to a frozen deep window.
 */
async function deriveArchivalSigsChallenge(
  ctx: ChallengeContext,
): Promise<{ params: GetSigsParams; bucket: string } | null> {
  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;

  const found = await withArchivalSlotRetries(tip, async (slot) => {
    const block = await ctx.utility.call<BlockKeysProbe>(
      "getBlock",
      [Number(slot), { encoding: "json", transactionDetails: "accounts", maxSupportedTransactionVersion: 0, rewards: false }],
      { timeoutMs: ARCHIVAL_UTILITY_TIMEOUT_MS },
    );
    // One pre-check call per candidate tx, few candidates per draw — keeps
    // each probe well inside the derive budget.
    for (const tx of (block?.transactions ?? []).slice(0, 3)) {
      const anchor = tx.transaction.signatures?.[0];
      const signer = tx.transaction.accountKeys?.find((k) => k?.signer === true)?.pubkey;
      if (!anchor || !signer) continue;
      const window = await ctx.utility.call<SigEntry[]>(
        "getSignaturesForAddress",
        [signer, { limit: SIGS_ARCHIVAL_LIMIT, before: anchor, commitment: "finalized" }],
        { timeoutMs: ARCHIVAL_UTILITY_TIMEOUT_MS },
      );
      if (Array.isArray(window) && window.length >= SIGS_ARCHIVAL_MIN_WINDOW) {
        return { address: signer, anchor };
      }
    }
    return null;
  });
  if (!found) return null;

  return {
    params: {
      address: found.value.address,
      options: { limit: SIGS_ARCHIVAL_LIMIT, before: found.value.anchor, commitment: "finalized" },
    },
    bucket: SIGS_ARCHIVAL_BUCKET,
  };
}

export async function deriveSigsChallenge(
  ctx: ChallengeContext,
  bucket: string,
): Promise<{ params: GetSigsParams; bucket: string } | null> {
  if (bucket.startsWith("archival")) return deriveArchivalSigsChallenge(ctx);

  const [activity, _addrType, cursor, limitStr] = bucket.split("__") as [
    "high" | "medium" | "low",
    "program" | "token_account" | "user_wallet",
    "latest" | "shallow" | "deep" | "window",
    `l${"10" | "100" | "1000"}`,
  ];
  const limit = parseInt(limitStr.slice(1), 10);

  const tip = ctx.recentSlots.length ? ctx.recentSlots[ctx.recentSlots.length - 1]! : 0n;
  if (tip === 0n) return null;

  // Pick a random recent slot, fetch its account keys, find one matching the
  // requested activity bucket.
  const probeSlot = tip - BigInt(1 + Math.floor(Math.random() * 9000));
  let block: BlockKeysProbe;
  try {
    block = await ctx.utility.call<BlockKeysProbe>("getBlock", [
      Number(probeSlot),
      { encoding: "json", transactionDetails: "accounts", maxSupportedTransactionVersion: 0, rewards: false },
    ]);
  } catch {
    return null;
  }
  // Filter candidates to TRANSACTION SIGNERS only. Non-signer account keys are
  // mostly program IDs / system accounts (Token Program, system program, hot
  // DEX programs) which classifyActivity invariably labels "high" — the
  // pruned bucket matrix only accepts non-high candidates, so accepting
  // those wastes ~90% of classifyActivity calls and starves derive of
  // non-high candidates. Signers are the wallet doing the transaction, much
  // more likely to be a regular user (low/medium activity). Cap raised from
  // 50 → 100 since signers are more diverse per block.
  const candidates = new Set<string>();
  for (const tx of block.transactions ?? []) {
    for (const k of tx.transaction.accountKeys ?? []) {
      // k is { pubkey, signer, source, writable } with transactionDetails=accounts.
      if (k && typeof k.pubkey === "string" && k.signer === true) {
        candidates.add(k.pubkey);
      }
    }
    if (candidates.size > 100) break;
  }

  for (const addr of candidates) {
    const a = await classifyActivity(ctx, addr);
    // Bucket-prune-aware activity match. Strict equality on the `high`
    // boundary (since the prune drops `high`-activity buckets entirely for
    // cross-camp tip-drift reasons), but treat `medium` and `low` buckets
    // as a single "non-high" class for candidate matching. Pre-fix, strict
    // equality after the prune dropped derive throughput to zero because
    // candidate addresses sampled from recent blocks are almost always
    // classified as `high`, and there are no `high` buckets left to match.
    if (activity === "high" ? a !== "high" : a === "high") continue;

    // Build pagination cursor.
    const opts: GetSigsParams["options"] = { limit, commitment: "finalized" };
    if (cursor === "shallow" || cursor === "deep" || cursor === "window") {
      try {
        const anchor = await ctx.utility.call<SigEntry[]>("getSignaturesForAddress", [
          addr,
          { limit: 1 },
        ]);
        if (anchor[0]?.signature) opts.before = anchor[0].signature;
      } catch {
        // anchor unavailable; fall back to latest
      }
    }
    return { params: { address: addr, options: opts }, bucket };
  }
  return null;
}

/**
 * Set-overlap correctness for sigs.
 *
 * Two providers "agree" if their signature sets overlap ≥ JACCARD_THRESHOLD
 * (default 0.8). Live multi-provider probing (on the v=1-era panel) showed
 * providers cluster into three "finalized" camps that don't naturally agree
 * on the tip of the sig list:
 *
 *   Camp A:  Helius, Triton          — strictest "finalized" semantics
 *   Camp B:  Alchemy, QuickNode, Flux — ~14 slots more aggressive
 *   Camp C:  SF Public               — 1-slot lag from Camp A
 *
 * For tip-active addresses with small `limit`, each camp's returned list lives
 * in a disjoint slot window — full-set Jaccard between Camp A and Camp B is
 * 0.00 even though both providers are operating correctly. To bridge this we
 * apply a *tip-anchored trim* before computing Jaccard: drop every sig newer
 * than `min(max_slot_per_side) - SIGS_SAFETY_SLOTS`. The resulting window is
 * old enough that all camps have settled what's finalized.
 *
 * Fall back to full-set Jaccard when the trim leaves too few sigs to be
 * meaningful — typically `limit=10` on a tip-active address where every
 * returned sig is within the safety window of the slowest camp. That bucket
 * is structurally hard to measure cross-camp; preserving the old behavior
 * there means Stage 2 only *adds* consensus pathways without taking any
 * existing ones away.
 *
 * Used by both the quorum decision in the generator and the per-sample
 * classify in workers. Callers pass the two projection shapes; this function
 * returns true if they're considered equivalent.
 */
export const SIGS_JACCARD_THRESHOLD = 0.8;

/**
 * Drop sigs newer than `min(max_slot_per_side) - SIGS_SAFETY_SLOTS` before
 * computing Jaccard. 32 slots ≈ 13 s — comfortably above the observed
 * inter-camp drift of ~14 slots, so within-camp agreement isn't accidentally
 * trimmed but cross-camp tip noise is.
 */
export const SIGS_SAFETY_SLOTS = 32;

/** Minimum sigs in each trimmed set for the tip-anchored compare to fire. */
export const SIGS_MIN_TRIMMED = 3;

/**
 * True when the projection's sigs list is empty — i.e. the provider returned
 * `ok` with `result: []`. Used by the quorum decision to distinguish
 * "abstention" (empty list, no data to vote with) from "active vote"
 * (non-empty list contributing to the consensus check).
 *
 * Motivation (observed on the v=1-era panel): SF Public retained only ~2 days
 * of sigs. For older-than-2-day addresses it returned an empty list while
 * Flux returned a full history.
 * Pre-fix, that flipped the decision to "ambiguous" (treating empty as a
 * dissenting vote). Post-fix, the empty side abstains and the non-empty
 * side becomes the reference.
 */
export function sigsProjectionIsEmpty(p: CanonicalProjection): boolean {
  const shape = p.shape as { sigs?: unknown[] } | null | undefined;
  if (!shape || !Array.isArray(shape.sigs)) return false;
  return shape.sigs.length === 0;
}

export function sigsProjectionsMatch(
  a: CanonicalProjection,
  b: CanonicalProjection,
): boolean {
  // Fast path: byte-equal projection hashes always match.
  if (buffersEqual(a.hash, b.hash)) return true;

  const sa = sigsWithSlotsFromShape(a.shape);
  const sb = sigsWithSlotsFromShape(b.shape);
  // Missing or malformed shape: degrade to byte-equal (already failed above).
  if (!sa || !sb) return false;
  if (sa.length === 0 && sb.length === 0) return true;
  if (sa.length === 0 || sb.length === 0) return false;

  // Tip-anchored trim. Each side's max_slot is a proxy for that provider's
  // finalized tip for this address; anchor at the lower of the two minus a
  // safety buffer.
  let maxA = sa[0]!.slot, maxB = sb[0]!.slot;
  for (const s of sa) if (s.slot > maxA) maxA = s.slot;
  for (const s of sb) if (s.slot > maxB) maxB = s.slot;
  const anchor = Math.min(maxA, maxB) - SIGS_SAFETY_SLOTS;
  const trimA = sa.filter((s) => s.slot <= anchor);
  const trimB = sb.filter((s) => s.slot <= anchor);

  if (trimA.length >= SIGS_MIN_TRIMMED && trimB.length >= SIGS_MIN_TRIMMED) {
    return jaccardAtLeast(
      new Set(trimA.map((s) => s.signature)),
      new Set(trimB.map((s) => s.signature)),
      SIGS_JACCARD_THRESHOLD,
    );
  }

  // Fallback: full-set Jaccard. Preserves the pre-Stage-2 behavior for
  // buckets where the tip-anchored trim leaves too few sigs (typically
  // tip-active addresses with limit=10).
  return jaccardAtLeast(
    new Set(sa.map((s) => s.signature)),
    new Set(sb.map((s) => s.signature)),
    SIGS_JACCARD_THRESHOLD,
  );
}

interface SigWithSlot {
  signature: string;
  slot: number;
}

function sigsWithSlotsFromShape(shape: unknown): SigWithSlot[] | null {
  if (!shape || typeof shape !== "object") return null;
  const sigs = (shape as { sigs?: Array<{ signature?: unknown; slot?: unknown }> }).sigs;
  if (!Array.isArray(sigs)) return null;
  const out: SigWithSlot[] = [];
  for (const s of sigs) {
    if (s && typeof s.signature === "string" && typeof s.slot === "number") {
      out.push({ signature: s.signature, slot: s.slot });
    }
  }
  return out;
}

export const handlers: MethodHandlers<GetSigsParams, SigEntry[]> = {
  buckets: BUCKETS,
  async deriveChallenge(ctx: ChallengeContext) {
    return deriveSigsChallenge(ctx, ctx.bucket);
  },
  project: projectImpl,
  classify(projection, reference, providerTipSlot, referenceTipSlot, bucket): Correctness {
    // Archival frozen window: the list is immutable, so any divergence is a
    // real archive gap — strict byte-equal, no Jaccard tolerance (0.8 would
    // mask a provider missing up to ~15% of deep history).
    if (bucket?.startsWith("archival")) {
      if (!buffersEqual(projection.hash, reference.hash)) return "incorrect";
      if (referenceTipSlot - providerTipSlot > 2n) return "stale";
      return "correct";
    }
    // Prefer shape-based Jaccard comparison when the reference has a shape
    // populated (the worker re-projects reference_response before calling
    // classify). Falls back to hash equality if shape is missing — preserves
    // the original strict semantics for backward compat.
    const matches = reference.shape != null
      ? sigsProjectionsMatch(projection, reference)
      : buffersEqual(projection.hash, reference.hash);
    if (!matches) return "incorrect";
    if (referenceTipSlot - providerTipSlot > 2n) return "stale";
    return "correct";
  },
};

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
