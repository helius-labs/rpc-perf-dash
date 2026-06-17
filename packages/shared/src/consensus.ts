/**
 * Consensus decision rules.
 *
 * Correctness is decided by a majority vote across the benchmarked panel
 * itself. Inputs are the provider responses the worker already collected via
 * fanout(); no separate RPC round is needed.
 *
 * Decision (first match wins):
 *
 *   1. fewer than 3 usable voters                    → AMBIGUOUS
 *   2. largest agreement group has fewer than 3 members → AMBIGUOUS
 *   3. largest group is not a strict majority (g > n/2) → AMBIGUOUS
 *   4. otherwise → CONSENSUS on that group; everyone outside it is a dissenter.
 *
 * Worked examples (n = usable voters):
 *
 *   n=5, split 5-0     → consensus (5 in majority, 0 dissenters)
 *   n=5, split 4-1     → consensus (4 in majority, 1 dissenter)
 *   n=5, split 3-2     → consensus (3 in majority, 2 dissenters)
 *   n=5, split 2-2-1   → ambiguous (largest=2 < 3)
 *   n=4, split 3-1     → consensus (matches the "if 3 agree and 1 doesn't,
 *                                   the 3 are correct" intent)
 *   n=4, split 2-2     → ambiguous (no strict majority)
 *   n=3, split 3-0     → consensus
 *   n=3, split 2-1     → ambiguous under the default floor (largest=2 < 3).
 *                        On methods whose STRUCTURAL panel is 3 voters
 *                        (a provider is declared unsupported_methods, e.g.
 *                        simulateBundle / getTransactionsForAddress), the
 *                        caller lowers `minGroup` to 2 and this becomes
 *                        consensus with one dissenter — two byte-equal
 *                        agreements out of three independent providers is
 *                        decisive, and the auditor cross-check still backstops
 *                        a wrong-pair.
 *   n<3                → ambiguous (too few voters; e.g. ≥3 timeouts)
 *
 * The `match` predicate is method-specific: byte-equal hash for immutable
 * methods, Jaccard ≥ 0.8 for sigs, slot tolerance for getSlot.
 *
 * A provider that returned a timeout / network error / null-where-data is
 * NOT passed in as a voter — it's already scored on the reliability /
 * completeness axes, and excluding it from the correctness vote keeps timeouts
 * from being double-penalized.
 */

export interface Voter<R> {
  /** Provider id. */
  id: string;
  /** Method-specific projection used for grouping. */
  projection: { hash: Uint8Array; shape: unknown };
  /** Raw response payload, returned to callers when this voter is in the majority. */
  response: R;
}

export type ConsensusOutcome<R> =
  | {
      kind: "consensus";
      /** Majority projection — what each provider was scored against. */
      reference_projection: { hash: Uint8Array; shape: unknown };
      /** Raw response from one majority voter (canonical reference body). */
      reference_response: R;
      /** Provider ids in the majority group. */
      majority_ids: readonly string[];
      /** Provider ids that voted but disagreed. */
      dissenter_ids: readonly string[];
    }
  | { kind: "ambiguous"; reason: string };

export interface ConsensusVote {
  /** Per-voter entry kept in `consensus_log` for the audit page. */
  id: string;
  projection_hash: string;
  in_majority: boolean;
}

/** Absolute floor for the majority-group size, on top of the strict-majority rule. */
export const MIN_CONSENSUS_GROUP = 3;
/** Minimum usable voters (responding providers) for any consensus to form. */
export const MIN_CONSENSUS_VOTERS = 3;

/**
 * Group voters by the `match` predicate (transitive within a group; the first
 * matching seed wins). Returns groups in descending size order — `groups[0]`
 * is the largest.
 *
 * For most methods `match` is byte-equal hash compare and transitivity is
 * trivial. For similarity methods (sigs Jaccard, slot tolerance) `match` is
 * not strictly transitive — we seed each group on its first member and
 * compare incoming voters against that seed, which is the same behavior
 * `decideQuorumWithSimilarity` relied on.
 */
function groupByMatch<R>(
  voters: readonly Voter<R>[],
  match: (a: Voter<R>["projection"], b: Voter<R>["projection"]) => boolean,
): Voter<R>[][] {
  const groups: Voter<R>[][] = [];
  for (const v of voters) {
    let placed = false;
    for (const g of groups) {
      if (match(g[0]!.projection, v.projection)) {
        g.push(v);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([v]);
  }
  groups.sort((a, b) => b.length - a.length);
  return groups;
}

/** Byte-for-byte equality of two raw byte arrays. */
export function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Default predicate: byte-equal projection-hash compare. */
export function byteEqualHash(
  a: Voter<unknown>["projection"],
  b: Voter<unknown>["projection"],
): boolean {
  return buffersEqual(a.hash, b.hash);
}

export function decideConsensus<R>(
  voters: readonly Voter<R>[],
  match: (a: Voter<R>["projection"], b: Voter<R>["projection"]) => boolean = byteEqualHash,
  opts?: {
    /**
     * Override of the majority-group floor (default MIN_CONSENSUS_GROUP).
     * Pass 2 for methods whose structural panel is 3 voters so a 2-1 split
     * decides instead of requiring unanimity. The strict-majority rule and
     * the MIN_CONSENSUS_VOTERS floor still apply unchanged.
     */
    minGroup?: number;
  },
): ConsensusOutcome<R> {
  const minGroup = opts?.minGroup ?? MIN_CONSENSUS_GROUP;
  const n = voters.length;
  if (n < MIN_CONSENSUS_VOTERS) {
    return {
      kind: "ambiguous",
      reason: `only ${n} usable voter(s); need >= ${MIN_CONSENSUS_VOTERS}`,
    };
  }

  const groups = groupByMatch(voters, match);
  const largest = groups[0]!;
  const g = largest.length;

  if (g < minGroup) {
    return {
      kind: "ambiguous",
      reason: `largest agreement group has ${g} member(s); need >= ${minGroup}`,
    };
  }
  if (g * 2 <= n) {
    return {
      kind: "ambiguous",
      reason: `largest group (${g}/${n}) is not a strict majority`,
    };
  }

  const majorityIds = largest.map((v) => v.id);
  const dissenterIds: string[] = [];
  for (const g_ of groups.slice(1)) {
    for (const v of g_) dissenterIds.push(v.id);
  }

  return {
    kind: "consensus",
    reference_projection: largest[0]!.projection,
    reference_response: largest[0]!.response,
    majority_ids: majorityIds,
    dissenter_ids: dissenterIds,
  };
}

/** Per-voter entries for `consensus_log.voters`. */
export function describeVotes<R>(
  voters: readonly Voter<R>[],
  outcome: ConsensusOutcome<R>,
): ConsensusVote[] {
  const majority = outcome.kind === "consensus" ? new Set(outcome.majority_ids) : new Set<string>();
  return voters.map((v) => ({
    id: v.id,
    projection_hash: Buffer.from(v.projection.hash).toString("hex"),
    in_majority: majority.has(v.id),
  }));
}
