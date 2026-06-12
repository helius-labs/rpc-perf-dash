/**
 * Per-(challenge, vantage) sample-row construction.
 *
 * Under methodology_version 2 this is also where **consensus is decided**:
 * the worker (apps/worker/src/index.ts) and the on-demand benchmark CLI
 * (apps/generator/src/benchmark.ts) each call fanout() to query all
 * benchmarked providers in parallel, then hand the results here. We have
 * every provider's response for this (challenge, vantage, mode) in memory,
 * so the majority vote happens locally — no DB round-trip, no separate
 * reference-fetching phase.
 *
 * Flow per mode (cold / warm — independent votes):
 *   1. Project each provider's response. Skip providers whose tier doesn't
 *      serve this method (ProviderRow.unsupported_methods — e.g. QuickNode
 *      on simulateBundle).
 *   2. Decide consensus across the projections that succeeded. ≥3 usable
 *      voters AND a strict majority of ≥3 members → consensus; else
 *      ambiguous (all samples for this mode dropped from scoring).
 *   3. Auditor cross-check: compare the consensus projection against the
 *      auditor reference (input.reference_*). agree → verified; disagree →
 *      disputed (samples dropped); auditor missing → auditor_unavailable
 *      (score on consensus alone, flagged).
 *   4. Stamp each provider's row: majority voter → correct (or stale via
 *      handler's freshness rule); dissenter → handler.classify decides
 *      between incorrect and stale; non-voter → ambiguous with the
 *      appropriate exclusion_reason.
 *
 * Honeypots short-circuit the whole consensus path: they have a pre-seeded
 * known answer in input.reference_*, and classification compares each
 * provider directly against it (consensus + auditor bypassed).
 */

import type { ConsensusLogRow, SampleRow } from "@rpcbench/db";
import {
  BENCHMARKED_PROVIDERS,
  METHODOLOGY_VERSION,
  MIN_CONSENSUS_VOTERS,
  byteEqualHash,
  decideConsensus,
  describeVotes,
  type CanonicalProjection,
  type ConsensusOutcome,
  type Correctness,
  type Method,
  type Voter,
} from "@rpcbench/shared";
import {
  HANDLERS,
  getSignaturesForAddress as sigsMod,
  getSlot as slotMod,
  getTokenLargestAccounts as tlaMod,
  freshness as freshnessMod,
  // Batch added 2026-05-31 — non-byte-equal predicates for the new methods.
  getEpochInfo as epochMod,
  getBlockHeight as blockHeightMod,
  getTransactionCount as txCountMod,
  getVoteAccounts as voteMod,
} from "@rpcbench/methods";
import {
  categorizeFailure,
  classifyAgainstReference,
  projectResponse,
  type ProjectAttempt,
} from "./classify.js";
import type { ProviderCallResult, SingleResult } from "./fanout.js";

const ARCHIVE_SAMPLE_RATE_DENOMINATOR = 100;

/** Deterministic 1% archive sampling on the challenge UUID. */
export function shouldArchive(challengeId: string): boolean {
  let h = 0;
  for (let i = 0; i < challengeId.length; i++) {
    h = (h * 31 + challengeId.charCodeAt(i)) >>> 0;
  }
  return h % ARCHIVE_SAMPLE_RATE_DENOMINATOR === 0;
}

export interface BuildSampleRowsInput {
  challenge_id: string;
  method: Method;
  bucket: string;
  worker_provider: string;
  region: string;
  worker_id: string;
  egress_path: string;
  /**
   * Auditor reference hash (methodology_version 2) — projection hash of the
   * UTILITY/auditor's answer to this challenge, captured at challenge
   * generation. For honeypots, this is the pre-seeded known answer instead.
   */
  reference_hash: Buffer;
  /** Full auditor reference response (or honeypot known answer). */
  reference_response?: unknown;
  reference_tip_slot: bigint;
  is_honeypot: boolean;
  archive: boolean;
  fanoutResults: readonly ProviderCallResult[];
  provider_tip_slots: Map<string, bigint>;
  startedAt: Date;
}

export interface BuildSampleRowsOutput {
  rows: SampleRow[];
  /**
   * Selective consensus_log rows for the audit page. Caller persists via
   * `insertConsensusLog`. Empty for honeypots (their ground truth is
   * pre-seeded, not consensus-derived).
   */
  consensus_log: ConsensusLogRow[];
}

/**
 * Build sample rows + the optional consensus-log rows for one (challenge,
 * vantage). Returns the rows; the caller persists them.
 *
 * Backwards-compat: workers and the CLI used to receive `SampleRow[]`. To
 * avoid signature churn at every call site, we also export
 * `buildSampleRowsLegacy` that returns just `SampleRow[]` — the new code path
 * should prefer the structured return.
 */
export function buildSampleRowsV2(input: BuildSampleRowsInput): BuildSampleRowsOutput {
  const rows: SampleRow[] = [];
  const logs: ConsensusLogRow[] = [];

  // Pre-project auditor reference once (used for the cross-check on every
  // mode). For honeypots reference_response IS the known answer; we still
  // re-project to get a CanonicalProjection.shape for the per-provider
  // classify call below.
  const auditorProjection = projectAuditorReference(input);

  for (const mode of ["cold", "warm"] as const) {
    const decided = decideForMode(input, mode, auditorProjection);
    const modeRows = buildRowsForMode(input, mode, decided);
    rows.push(...modeRows);

    // Honeypots: ground truth is pre-seeded, the consensus path is bypassed
    // — nothing meaningful to log per vantage/mode beyond what's already in
    // samples.is_honeypot.
    if (!input.is_honeypot && decided.shouldLog) {
      logs.push({
        challenge_id: input.challenge_id,
        worker_provider: input.worker_provider,
        region: input.region,
        egress_path: input.egress_path,
        connection_mode: mode,
        voters: decided.voterDescriptions,
        decision:
          decided.consensus.kind === "consensus"
            ? "consensus"
            : decided.livenessFallbackActive
              ? "liveness_fallback"
              : "ambiguous",
        decision_reason:
          decided.consensus.kind === "ambiguous" ? decided.consensus.reason : null,
        dissenters:
          decided.consensus.kind === "consensus"
            ? [...decided.consensus.dissenter_ids]
            : [],
        auditor_verdict: decided.auditor_verdict,
      });
    }
  }

  return { rows, consensus_log: logs };
}

/** Back-compat shim — returns the flattened sample-row list. */
export function buildSampleRows(input: BuildSampleRowsInput): SampleRow[] {
  return buildSampleRowsV2(input).rows;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

interface DecidedMode {
  /** Per-provider projection result (in fanoutResults order). */
  attempts: ReadonlyMap<string, ProjectAttempt>;
  /** Whether each provider is structurally a non-voter on this method. */
  unsupported: ReadonlySet<string>;
  consensus: ConsensusOutcome<unknown>;
  auditor_verdict: "verified" | "disputed" | "auditor_unavailable";
  /**
   * Hybrid value methods only: a ≥3-voter panel formed but no value-majority
   * emerged (the value churned across the parallel reads). When true,
   * `decideProviderOutcome` scores each provider on freshness via the handler's
   * `livenessFallback` instead of dropping the samples as `no_consensus`, and
   * the consensus_log row records `decision = "liveness_fallback"`.
   */
  livenessFallbackActive: boolean;
  /** Pre-built voters list — keeps `describeVotes` aligned with the decision. */
  voters: ReadonlyArray<Voter<unknown>>;
  voterDescriptions: ReturnType<typeof describeVotes<unknown>>;
  shouldLog: boolean;
}

function decideForMode(
  input: BuildSampleRowsInput,
  mode: "cold" | "warm",
  auditorProjection: CanonicalProjection | null,
): DecidedMode {
  const method = input.method;
  const match = matchPredicateForMethod(method);
  // Auditor cross-check uses a SEPARATE predicate because the auditor's
  // projection is captured at challenge generation (t=0) and the panel's
  // consensus is captured at worker fanout (t+δ). For getSlot specifically,
  // the network legitimately advances ~2.5 slots/s during δ, so reusing the
  // tight consensus tolerance guarantees a false "disputed" verdict. Most
  // methods are time-stable and reuse the consensus predicate as-is.
  const auditorMatch = auditorMatchPredicateForMethod(method);

  const attempts = new Map<string, ProjectAttempt>();
  const unsupported = new Set<string>();
  const voters: Voter<unknown>[] = [];

  for (const r of input.fanoutResults) {
    const single = mode === "cold" ? r.cold : r.warm;
    const cfg = BENCHMARKED_PROVIDERS.find((p) => p.id === r.provider_id);
    const isUnsupported = cfg?.unsupported_methods?.includes(method) ?? false;
    if (isUnsupported) unsupported.add(r.provider_id);

    const attempt = projectResponse(method, single.body, single.status);
    attempts.set(r.provider_id, attempt);

    // Only "ok" attempts on a *supported* method become voters. A provider
    // whose tier doesn't serve the method is excluded from the vote even if
    // it somehow returned a parsable body — it's not in the panel for this
    // method by construction.
    if (!isUnsupported && attempt.outcome === "ok" && attempt.projection !== null) {
      voters.push({
        id: r.provider_id,
        projection: attempt.projection,
        response: attempt.result,
      });
    }
  }

  // Honeypots bypass consensus entirely — the pre-seeded reference IS truth.
  if (input.is_honeypot) {
    return {
      attempts,
      unsupported,
      consensus: { kind: "ambiguous", reason: "honeypot (consensus bypassed)" },
      auditor_verdict: "verified",
      livenessFallbackActive: false,
      voters,
      voterDescriptions: [],
      shouldLog: false,
    };
  }

  const consensus = decideConsensus(voters, match);

  // Hybrid liveness fallback: a real (≥3-voter) panel formed but no value-
  // majority emerged — the value churned across the parallel reads. Score on
  // freshness rather than dropping. Gated on voter COUNT (not just
  // `kind === "ambiguous"`) so the <3-voter degraded-panel case stays
  // `no_consensus` and never inflates the correctness denominator.
  const livenessFallbackActive =
    HANDLERS[method].livenessFallback != null &&
    consensus.kind === "ambiguous" &&
    voters.length >= MIN_CONSENSUS_VOTERS;

  // Auditor cross-check.
  let auditor_verdict: DecidedMode["auditor_verdict"];
  if (auditorProjection === null) {
    auditor_verdict = "auditor_unavailable";
  } else if (consensus.kind === "consensus") {
    auditor_verdict = auditorMatch(consensus.reference_projection, auditorProjection)
      ? "verified"
      : "disputed";
  } else {
    // Consensus ambiguous — auditor verdict is moot for scoring, but for the
    // log we still record what the auditor said relative to the largest
    // (sub-majority) group, defaulting to "verified" when we don't have a
    // meaningful comparison. Simpler: mark "verified" so the log accurately
    // says "the auditor wasn't the reason this was ambiguous."
    auditor_verdict = "verified";
  }

  const voterDescriptions = describeVotes(voters, consensus);

  // Log selectively: anything disputed / ambiguous, plus the 1% archive
  // sample, so dashboards have a representative trail without per-vantage-
  // per-mode log volume on healthy traffic.
  const shouldLog =
    consensus.kind === "ambiguous" ||
    auditor_verdict === "disputed" ||
    auditor_verdict === "auditor_unavailable" ||
    livenessFallbackActive ||
    input.archive;

  return {
    attempts,
    unsupported,
    consensus,
    auditor_verdict,
    livenessFallbackActive,
    voters,
    voterDescriptions,
    shouldLog,
  };
}

function buildRowsForMode(
  input: BuildSampleRowsInput,
  mode: "cold" | "warm",
  decided: DecidedMode,
): SampleRow[] {
  const rows: SampleRow[] = [];
  const majorityIds =
    decided.consensus.kind === "consensus"
      ? new Set(decided.consensus.majority_ids)
      : new Set<string>();

  // The reference passed to classify():
  //   - honeypot     → pre-seeded known answer (input.reference_*)
  //   - consensus    → the consensus group's projection
  //   - ambiguous    → unused (we stamp ambiguous up front)
  //   - disputed     → unused (we stamp ambiguous up front)
  let consensusReferenceShape: unknown = null;
  let consensusReferenceHash: Uint8Array | null = null;
  if (!input.is_honeypot && decided.consensus.kind === "consensus") {
    consensusReferenceShape = decided.consensus.reference_projection.shape;
    consensusReferenceHash = decided.consensus.reference_projection.hash;
  }

  for (const r of input.fanoutResults) {
    const single = mode === "cold" ? r.cold : r.warm;
    const attempt = decided.attempts.get(r.provider_id)!;
    const isUnsupported = decided.unsupported.has(r.provider_id);

    const measuredTip = input.provider_tip_slots.get(r.provider_id);
    const provider_tip_slot: bigint | null = measuredTip ?? null;
    // classify uses bigint for the stale check; missing tip → reuse
    // reference_tip so the diff is 0 and stale isn't fired spuriously.
    const provider_tip_for_classify = provider_tip_slot ?? input.reference_tip_slot;

    const { correctness, exclusion_reason } = decideProviderOutcome({
      method: input.method,
      mode,
      provider_id: r.provider_id,
      single,
      attempt,
      isUnsupported,
      decided,
      majorityIds,
      isHoneypot: input.is_honeypot,
      honeypotOrConsensus: input.is_honeypot
        ? {
            hash: new Uint8Array(input.reference_hash),
            // Re-project so classify gets `reference.shape` for shape-based
            // methods (sigs Jaccard, etc.). For byte-equal methods .shape is
            // unused. Done lazily below.
            shape: null as unknown,
          }
        : consensusReferenceHash !== null
          ? { hash: consensusReferenceHash, shape: consensusReferenceShape }
          : null,
      reference_tip_slot: input.reference_tip_slot,
      provider_tip_for_classify,
      reference_response_for_shape: input.is_honeypot ? input.reference_response : undefined,
    });

    const flagged = correctness !== "correct" || single.status !== "ok";
    const keepRaw = input.archive || flagged || input.is_honeypot;
    const freshnessLag: bigint | null =
      provider_tip_slot === null ? null : input.reference_tip_slot - provider_tip_slot;

    const cat = categorizeFailure({
      status: single.status,
      http_status: single.http_status,
      error_code: single.error_code,
      body: single.body,
      correctness,
      exclusion_reason,
      freshness_lag: freshnessLag ?? 0n,
    });

    rows.push({
      challenge_id: input.challenge_id,
      method: input.method,
      provider_id: r.provider_id,
      plan_tier: null,
      worker_provider: input.worker_provider,
      region: input.region,
      worker_id: input.worker_id,
      egress_path: input.egress_path,
      endpoint_used: r.endpoint_used,
      bucket: input.bucket,
      connection_mode: mode,
      started_at: input.startedAt,
      latency_ms: single.latency_ms,
      status: single.status,
      error_code: single.error_code,
      http_status: single.http_status,
      response_hash: attempt.response_hash,
      provider_tip_slot,
      reference_tip_slot: input.reference_tip_slot,
      response_slot: attempt.response_slot,
      freshness_lag: freshnessLag,
      correctness,
      exclusion_reason,
      failure_category: cat.failure_category,
      failure_detail: cat.failure_detail,
      methodology_version: METHODOLOGY_VERSION,
      is_honeypot: input.is_honeypot,
      ranking_eligible: true,
      raw_response: keepRaw && single.body ? safeParse(single.body) : null,
    });
  }

  return rows;
}

interface DecideOutcomeInput {
  method: Method;
  mode: "cold" | "warm";
  provider_id: string;
  single: SingleResult;
  attempt: ProjectAttempt;
  isUnsupported: boolean;
  decided: DecidedMode;
  majorityIds: ReadonlySet<string>;
  isHoneypot: boolean;
  honeypotOrConsensus: { hash: Uint8Array; shape: unknown } | null;
  reference_response_for_shape: unknown;
  reference_tip_slot: bigint;
  provider_tip_for_classify: bigint;
}

function decideProviderOutcome(
  d: DecideOutcomeInput,
): { correctness: Correctness; exclusion_reason: string | null } {
  // 1) Provider's tier doesn't serve this method — out of the panel for this
  //    method by construction. Drop from both correctness and reliability
  //    denominators (correctness=ambiguous keeps it out of both).
  if (d.isUnsupported) {
    return { correctness: "ambiguous", exclusion_reason: "tier_method_unsupported" };
  }

  // 2) Transport-level failure — no body to project.
  if (d.attempt.outcome === "reliability_failure") {
    return { correctness: "incorrect", exclusion_reason: "reliability_failure" };
  }

  // 3) Unparseable / RPC-error bodies — count as correctness failures, like
  //    today. (`categorizeFailure` will refine into `body_invalid` /
  //    `rpc_error` for the failure-breakdown table.)
  if (d.attempt.outcome === "body_invalid" || d.attempt.outcome === "rpc_error") {
    return { correctness: "incorrect", exclusion_reason: "correctness_failure" };
  }

  // From here on, projection succeeded — attempt.projection is non-null.
  const projection = d.attempt.projection!;

  // 4) Honeypot path — classify against the pre-seeded known answer.
  if (d.isHoneypot) {
    return classifyWithFreshness({
      method: d.method,
      projection,
      reference_hash_or_shape: d.honeypotOrConsensus!,
      reference_response_for_shape: d.reference_response_for_shape,
      reference_tip_slot: d.reference_tip_slot,
      provider_tip_slot: d.provider_tip_for_classify,
    });
  }

  // 5) Consensus failed → ambiguous. For Hybrid value methods where a ≥3-voter
  //    panel formed but no value-majority emerged, score on freshness via the
  //    handler's livenessFallback instead of dropping (the value churned
  //    in-window — not a provider fault). Every other ambiguous case (incl.
  //    the <3-voter degraded panel) keeps the no_consensus drop.
  if (d.decided.consensus.kind === "ambiguous") {
    if (d.decided.livenessFallbackActive) {
      const fb = HANDLERS[d.method].livenessFallback!(projection, d.reference_tip_slot);
      if (fb === "stale") return { correctness: "stale", exclusion_reason: "freshness_stale" };
      if (fb === "incorrect")
        return { correctness: "incorrect", exclusion_reason: "correctness_failure" };
      return { correctness: "correct", exclusion_reason: null };
    }
    return { correctness: "ambiguous", exclusion_reason: "no_consensus" };
  }

  // 6) Consensus succeeded but auditor disagreed → drop (don't score against
  //    contested ground truth).
  if (d.decided.auditor_verdict === "disputed") {
    return { correctness: "ambiguous", exclusion_reason: "consensus_disputed" };
  }

  // 7) Consensus succeeded (verified or auditor_unavailable). Classify each
  //    provider against the consensus reference. Majority members will hash-
  //    match by construction — they only fall through to anything other than
  //    `correct` if the freshness check fires (mutable-state methods).
  //    auditor_unavailable: we still score, but mark the sample so the
  //    dashboard can surface the audit-coverage gap.
  const result = classifyWithFreshness({
    method: d.method,
    projection,
    reference_hash_or_shape: d.honeypotOrConsensus!,
    reference_response_for_shape: undefined,
    reference_tip_slot: d.reference_tip_slot,
    provider_tip_slot: d.provider_tip_for_classify,
  });

  if (
    d.decided.auditor_verdict === "auditor_unavailable" &&
    result.correctness === "correct"
  ) {
    return { correctness: "correct", exclusion_reason: "auditor_unavailable" };
  }
  // Sanity: a provider in the majority should land on "correct" (modulo
  // freshness). If we somehow get "incorrect" for a majority voter (e.g.
  // the per-method classifier disagrees with the panel-equivalence match),
  // prefer the panel verdict — we already established membership via the
  // same match predicate the handler uses for the immutable methods.
  if (d.majorityIds.has(d.provider_id) && result.correctness === "incorrect") {
    return { correctness: "correct", exclusion_reason: null };
  }
  return result;
}

function classifyWithFreshness(args: {
  method: Method;
  projection: CanonicalProjection;
  reference_hash_or_shape: { hash: Uint8Array; shape: unknown };
  /** For honeypots: re-project from the stored payload to populate reference.shape. */
  reference_response_for_shape: unknown;
  reference_tip_slot: bigint;
  provider_tip_slot: bigint;
}): { correctness: Correctness; exclusion_reason: string | null } {
  let referenceShape = args.reference_hash_or_shape.shape;
  if (referenceShape === null && args.reference_response_for_shape !== undefined) {
    // Honeypot path: shape wasn't pre-computed; re-project lazily.
    try {
      referenceShape = HANDLERS[args.method].project(args.reference_response_for_shape).shape;
    } catch {
      // Stay null; classify falls back to hash comparison.
    }
  }
  const reference = { hash: args.reference_hash_or_shape.hash, shape: referenceShape };

  const correctness = classifyAgainstReference({
    method: args.method,
    projection: args.projection,
    reference,
    reference_tip_slot: args.reference_tip_slot,
    provider_tip_slot: args.provider_tip_slot,
  });

  let exclusion_reason: string | null = null;
  if (correctness === "incorrect") exclusion_reason = "correctness_failure";
  else if (correctness === "stale") exclusion_reason = "freshness_stale";
  else if (correctness === "ambiguous") exclusion_reason = "no_consensus";
  else if (correctness === "incomplete") exclusion_reason = "tier_archive_unavailable";

  return { correctness, exclusion_reason };
}

function projectAuditorReference(
  input: BuildSampleRowsInput,
): CanonicalProjection | null {
  if (input.reference_response === undefined || input.reference_response === null) {
    // For honeypots we always have reference_response (the known answer). For
    // normal challenges we may have an unavailable auditor — handled as
    // "auditor_unavailable" downstream.
    if (input.reference_hash.length === 0) return null;
    // We have a hash but no full response — fall back to a hash-only stub.
    return { hash: new Uint8Array(input.reference_hash), shape: null };
  }
  try {
    return HANDLERS[input.method].project(input.reference_response);
  } catch {
    return input.reference_hash.length > 0
      ? { hash: new Uint8Array(input.reference_hash), shape: null }
      : null;
  }
}

/**
 * Per-method match predicate for the CONSENSUS vote. Mirrors the predicate
 * the per-method handler.classify uses internally so a provider that's in
 * the majority by the panel vote also classifies as `correct` against the
 * majority's projection.
 */
function matchPredicateForMethod(
  method: Method,
): (a: CanonicalProjection, b: CanonicalProjection) => boolean {
  if (method === "getSignaturesForAddress") return sigsMod.sigsProjectionsMatch;
  if (method === "getSlot") return slotMod.slotProjectionsMatch;
  // Time-advancing scalars: consensus on the returned context.slot (their
  // projection shape carries `slot`, so getSlot's slot-tolerance predicate
  // applies directly).
  if (method === "getSupply" || method === "getLatestBlockhash") {
    return slotMod.slotProjectionsMatch;
  }
  // B1 tip-slot freshness: getMaxRetransmitSlot/getMaxShredInsertSlot return a
  // bare slot in shape.slot, so they reuse getSlot's slot-tolerance predicate.
  if (method === "getMaxRetransmitSlot" || method === "getMaxShredInsertSlot") {
    return slotMod.slotProjectionsMatch;
  }
  // B1 getEpochInfo: epoch must match AND absoluteSlot within tolerance (a plain
  // slot tolerance would wrongly match across an epoch rollover).
  if (method === "getEpochInfo") return epochMod.epochInfoProjectionsMatch;
  // B2 value-tolerance scalars: block height / tx counter compared within a
  // numeric tolerance (NOT a slot tolerance against the tip).
  if (method === "getBlockHeight") return blockHeightMod.blockHeightProjectionsMatch;
  if (method === "getTransactionCount") return txCountMod.txCountProjectionsMatch;
  // C set-similarity: Jaccard over the vote-pubkey set. (getRecentPerformanceSamples
  // is well-formedness/byte-equal — providers sample at disjoint slots — so it
  // uses the default predicate below.)
  if (method === "getVoteAccounts") return voteMod.voteAccountsProjectionsMatch;
  // Top-20 holder set: Jaccard over holder addresses.
  if (method === "getTokenLargestAccounts") return tlaMod.tlaProjectionsMatch;
  // (getLargestAccounts / getClusterNodes are dormant — not emitted — so they
  // need no consensus predicate here. getClusterNodes' committed family is
  // well-formedness, which uses the default byte-equal predicate anyway.)
  // Hybrid value methods (getBalance / getTokenSupply / getTokenAccountBalance)
  // hash the value only, so the default byte-equal predicate groups voters by
  // value — a value-majority verifies it; no value-majority triggers the
  // liveness fallback in decideForMode.
  return byteEqualHash as (a: CanonicalProjection, b: CanonicalProjection) => boolean;
}

/**
 * Per-method match predicate for the AUDITOR cross-check. Same as the
 * consensus predicate for time-stable methods (where both sides resolve to
 * the same answer regardless of when they were measured). For getSlot the
 * auditor predicate uses a wider tolerance to absorb the t=0 → t+δ slot
 * advance between auditor reference capture and worker fanout — without
 * this, getSlot is guaranteed to read `consensus_disputed` on every challenge.
 */
function auditorMatchPredicateForMethod(
  method: Method,
): (a: CanonicalProjection, b: CanonicalProjection) => boolean {
  if (method === "getSlot") return slotMod.slotProjectionsMatchAuditor;
  // Time-advancing scalars need the wide auditor tolerance for the same reason
  // getSlot does (the network advances during the t=0 → t+δ window).
  if (method === "getSupply" || method === "getLatestBlockhash") {
    return slotMod.slotProjectionsMatchAuditor;
  }
  // B1/B2 advancing scalars need the wide auditor tolerance too.
  if (method === "getMaxRetransmitSlot" || method === "getMaxShredInsertSlot") {
    return slotMod.slotProjectionsMatchAuditor;
  }
  if (method === "getEpochInfo") return epochMod.epochInfoProjectionsMatchAuditor;
  if (method === "getBlockHeight") return blockHeightMod.blockHeightProjectionsMatchAuditor;
  if (method === "getTransactionCount") return txCountMod.txCountProjectionsMatchAuditor;
  // getVoteAccounts / getRecentPerformanceSamples (Jaccard) reuse the consensus
  // predicate below — Jaccard already absorbs t=0 → t+δ set churn (like sigs/TLA).
  // Hybrid value methods: lenient predicate — the auditor "agrees" if the
  // value hash matches OR the panel (consensus) slot is at least as fresh as
  // the auditor's, so in-window value drift doesn't spuriously dispute.
  if (
    method === "getBalance" ||
    method === "getTokenSupply" ||
    method === "getTokenAccountBalance" ||
    method === "getFeeForMessage"
  ) {
    return freshnessMod.valueOrFreshMatch;
  }
  // Sigs and getTokenLargestAccounts use Jaccard, which already absorbs their
  // own intra-side churn; immutable methods (block / transaction / accountInfo
  // / programAccounts / tokenAccountsByOwner) are time-stable. Reuse the
  // consensus predicate.
  return matchPredicateForMethod(method);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { unparseable: s.slice(0, 1000) };
  }
}
