export type Method =
  | "getBlock"
  | "getTransaction"
  | "getSignaturesForAddress"
  | "getSlot"
  | "getAccountInfo"
  | "getProgramAccounts"
  | "getTokenAccountsByOwner"
  | "getBalance"
  | "getSupply"
  | "getTokenSupply"
  | "getTokenLargestAccounts"
  | "getLatestBlockhash"
  | "getTokenAccountBalance"
  // ── Batch added 2026-05-31: 24 additional read methods. See
  // docs/methodology.md "Projection & equivalence" for each method's archetype.
  // Archetype A — deterministic byte-equal (pin to finalized data):
  | "getGenesisHash"
  | "getEpochSchedule"
  | "getInflationGovernor"
  | "getInflationRate"
  | "getBlockTime"
  | "getBlockCommitment"
  | "getBlocks"
  | "getInflationReward"
  | "getLeaderSchedule"
  | "getBlockProduction"
  // Archetype B1 — tip-slot freshness:
  | "getMaxRetransmitSlot"
  | "getMaxShredInsertSlot"
  | "getEpochInfo"
  // Archetype B2 — value-tolerance scalar:
  | "getBlockHeight"
  | "getTransactionCount"
  // Archetype C — set similarity (Jaccard):
  | "getVoteAccounts"
  | "getRecentPerformanceSamples"
  // Archetype D — node-identity, well-formedness-only:
  | "getIdentity"
  | "getVersion"
  // Archetype E — boolean / health / leader (byte-equal on normalized value):
  | "getHealth"
  | "isBlockhashValid"
  | "getSlotLeader"
  | "getSlotLeaders"
  // Archetype F — simulation (hand-rolled tx):
  | "simulateTransaction"
  | "simulateBundle"
  // ── Batch added 2026-06-01: 9 additional methods. ──
  // Archetype Z — mutable-structural byte-equal (excludes mutable balance):
  | "getMultipleAccounts"
  // Archetype A — deterministic byte-equal (pinned finalized / network constant):
  | "getSignatureStatuses"
  | "getMinimumBalanceForRentExemption"
  | "getStakeMinimumDelegation"
  | "getBlocksWithLimit"
  // Archetype D — well-formedness-only (disjoint per-provider windows):
  | "getRecentPrioritizationFees"
  // Archetype C — set similarity (Jaccard); getClusterNodes has a WF fallback:
  | "getClusterNodes"
  | "getLargestAccounts"
  // Hybrid value (value-majority byte-equal + freshness liveness fallback):
  | "getFeeForMessage"
  // ── Batch added 2026-06-12. ──
  // Custom indexer-backed address-history method (Helius/Triton/Alchemy;
  // QuickNode serves a non-comparable variant → 3-voter panel). Slot-pinned
  // challenges, strict byte-equal — Archetype A:
  | "getTransactionsForAddress";

/**
 * Methods scored on LATENCY + RELIABILITY only — correctness is not validated
 * cross-provider.
 *
 * Empty under methodology_version 2: with majority consensus across the
 * benchmarked panel, the enumeration methods (getProgramAccounts,
 * getTokenAccountsByOwner) that v=1 had to skip can now form consensus.
 * Reserved as an extension point if a future method proves impossible to
 * reach consensus on.
 */
export const LATENCY_ONLY_METHODS: ReadonlySet<Method> = new Set<Method>();

export type Region = string;

export type EgressPath = string;

export type WorkerProvider = string;

export const GEO_REGIONS = [
  "na-east",
  "eu-central",
  "ap-northeast",
  "na-west",
  "eu-west",
  "ap-southeast",
] as const;

export type GeoRegion = (typeof GEO_REGIONS)[number];

export const GEO_REGION_MAP: Record<string, Record<string, GeoRegion>> = {
  aws: {
    "us-east-2": "na-east",
    "us-east-1": "na-east",
    "us-west-2": "na-west",
    "eu-central-1": "eu-central",
    "eu-west-2": "eu-west",
    "ap-northeast-1": "ap-northeast",
    "ap-southeast-1": "ap-southeast",
  },
  gcp: {
    "us-east4": "na-east",
    "us-west1": "na-west",
    "europe-west3": "eu-central",
    "europe-west2": "eu-west",
    "asia-northeast1": "ap-northeast",
    "asia-southeast1": "ap-southeast",
  },
  teraswitch: {
    ewr: "na-east",
    pitt: "na-east",
    la: "na-west",
    van: "na-west",
    fra: "eu-central",
    ams: "eu-central",
    dub: "eu-west",
    tokyo: "ap-northeast",
    sgp: "ap-southeast",
  },
  latitude: {
    pitt: "na-east",
    ewr: "na-east",
    la: "na-west",
    van: "na-west",
    fra: "eu-central",
    ams: "eu-central",
    dub: "eu-west",
    tokyo: "ap-northeast",
    sgp: "ap-southeast",
  },
  // Cloudflare PoP codes (lowercased IATA). CF Containers picks a PoP per
  // instance; the running container reports its own PoP via the cdn-cgi/trace
  // endpoint, which we then map back to one of our geos. Not exhaustive —
  // only PoPs CF Containers is likely to schedule onto. Unknown codes fall
  // through to the na-east default (and emit a console.warn) so a new PoP
  // surfaces visibly rather than silently mis-binning.
  cloudflare: {
    // North America East
    iad: "na-east", // Ashburn
    ewr: "na-east", // Newark
    ord: "na-east", // Chicago
    atl: "na-east", // Atlanta
    mia: "na-east", // Miami
    yyz: "na-east", // Toronto
    yul: "na-east", // Montreal
    // North America West
    lax: "na-west", // Los Angeles
    sjc: "na-west", // San Jose
    sea: "na-west", // Seattle
    den: "na-west", // Denver
    phx: "na-west", // Phoenix
    yvr: "na-west", // Vancouver
    // Europe Central
    fra: "eu-central", // Frankfurt
    ams: "eu-central", // Amsterdam
    muc: "eu-central", // Munich
    vie: "eu-central", // Vienna
    waw: "eu-central", // Warsaw
    prg: "eu-central", // Prague
    arn: "eu-central", // Stockholm
    cph: "eu-central", // Copenhagen
    // Europe West
    lhr: "eu-west", // London
    cdg: "eu-west", // Paris
    dub: "eu-west", // Dublin
    mad: "eu-west", // Madrid
    mrs: "eu-west", // Marseille
    // Asia Pacific Northeast
    nrt: "ap-northeast", // Tokyo Narita
    kix: "ap-northeast", // Osaka
    hnd: "ap-northeast", // Tokyo Haneda
    icn: "ap-northeast", // Seoul
    // Asia Pacific Southeast
    sin: "ap-southeast", // Singapore
    hkg: "ap-southeast", // Hong Kong
    bkk: "ap-southeast", // Bangkok
    syd: "ap-southeast", // Sydney
    kul: "ap-southeast", // Kuala Lumpur
    // Default for backwards-compat: pre-PoP-detection deploys still wrote
    // worker_region='global'. Treat as na-east since CF's default scheduling
    // tends US-east for new accounts.
    global: "na-east",
  },
};

// Cloudflare used to be treated as "global" — that was a design oversight.
// Each CF Containers instance runs at one specific PoP, which the running
// worker now discovers at startup via cdn-cgi/trace and reports as a lowercased
// IATA code (yyz, iad, lhr, ...). Mapped to a real geo region via the
// GEO_REGION_MAP entry above. The "global" backwards-compat key in the CF
// submap maps to na-east for any pre-PoP-detection rows.
export type GeoRegionOrGlobal = GeoRegion;

const NA_EAST_FALLBACK: GeoRegion = "na-east";

export function geoRegionOf(
  workerProvider: string,
  region: string,
): GeoRegion {
  const sub = GEO_REGION_MAP[workerProvider];
  if (sub) {
    const hit = sub[region];
    if (hit) return hit;
  }
  // Benchmark CLI gets pooled into na-east (where the operator runs) without a
  // warning — it's expected to be unmapped, the warning would be noise.
  if (workerProvider !== "benchmark-cli") {
    // eslint-disable-next-line no-console
    console.warn(
      `[geoRegionOf] unknown (worker_provider=${workerProvider}, region=${region}); falling back to ${NA_EAST_FALLBACK}`,
    );
  }
  return NA_EAST_FALLBACK;
}

/** Inverse of geoRegionOf: which (worker_provider, region) pairs map to a given geo. */
export function cloudRegionsForGeo(
  geo: GeoRegion,
): Array<{ worker_provider: string; region: string }> {
  const out: Array<{ worker_provider: string; region: string }> = [];
  for (const [worker_provider, regions] of Object.entries(GEO_REGION_MAP)) {
    for (const [region, mapped] of Object.entries(regions)) {
      if (mapped === geo) out.push({ worker_provider, region });
    }
  }
  return out;
}

/**
 * Map a requested window (hours) to the coarsest ROLLUP source table that
 * still satisfies it, for the latency CHART. The chart always reads rollups:
 * ≤24h → 5-min grain, ≤7d → hourly, >7d → daily. Returns a validated constant
 * table name (never user input) safe to splice via sql.raw.
 */
export function rollupTableForWindow(windowHours: number): "rollups_5m" | "rollups_1h" | "rollups_1d" {
  if (windowHours <= 24) return "rollups_5m";
  if (windowHours <= 168) return "rollups_1h";
  return "rollups_1d";
}

/**
 * Map a window to the LEADERBOARD precompute table. The precompute is refreshed
 * every 5 min (the generator's rollup tick upserts the trailing 2h/2d), so it
 * serves ALL windows now — not just long ones. ≤7d → hourly grain, >7d → daily
 * grain. Returns a validated constant table name (never user input) safe to
 * splice via sql.raw.
 */
export function leaderboardTableForWindow(windowHours: number): "leaderboard_agg_1h" | "leaderboard_agg_1d" {
  return windowHours <= 168 ? "leaderboard_agg_1h" : "leaderboard_agg_1d";
}

/** Companion challenge-count table paired with leaderboardTableForWindow. */
export function leaderboardChallengesTableForWindow(windowHours: number): "leaderboard_challenges_1h" | "leaderboard_challenges_1d" {
  return windowHours <= 168 ? "leaderboard_challenges_1h" : "leaderboard_challenges_1d";
}

/** Companion per-failure-category table paired with leaderboardTableForWindow. */
export function leaderboardFailuresTableForWindow(windowHours: number): "leaderboard_failures_1h" | "leaderboard_failures_1d" {
  return windowHours <= 168 ? "leaderboard_failures_1h" : "leaderboard_failures_1d";
}

/** Sentinel worker_provider value for the pooled "all infra" precompute rows. */
export const POOLED_INFRA = "__all__";

/** Human-readable label per geo region for the UI. */
export const GEO_REGION_LABELS: Record<GeoRegion, string> = {
  "na-east": "NA East",
  "eu-central": "EU Central",
  "ap-northeast": "AP Northeast",
  "na-west": "NA West",
  "eu-west": "EU West",
  "ap-southeast": "AP Southeast",
};

export type ConnectionMode = "cold" | "warm";

export type Correctness =
  | "correct"
  | "incorrect"
  | "incomplete"
  | "stale"
  | "ambiguous";

export type SampleStatus = "ok" | "error" | "timeout";

export type ExclusionReason =
  | "tier_archive_unavailable"
  /**
   * Provider's tier structurally cannot serve this method (declared in
   * ProviderRow.unsupported_methods). Sample drops from both correctness and
   * reliability denominators — penalizing a benchmarked provider for a
   * tier-level "method not available" would be double-counting against a
   * known, disclosed limitation. Example: QuickNode on simulateBundle.
   */
  | "tier_method_unsupported"
  | "tier_rate_limited"
  /**
   * No usable majority among the benchmarked-panel voters for this
   * (challenge, vantage, mode) — formerly `quorum_ambiguous` in v=1.
   * Sample drops from both correctness and reliability denominators.
   */
  | "no_consensus"
  /**
   * Consensus formed, but the independent auditor (utility endpoint) returned
   * a projection that disagrees with the consensus answer. Every sample for
   * this challenge × vantage × mode is excluded from scoring — we won't score
   * against contested ground truth. New under methodology_version 2.
   */
  | "consensus_disputed"
  /**
   * Consensus formed AND the auditor was unreachable — sample scored on
   * consensus alone; flagged so dashboards can show the audit-coverage rate.
   * Does NOT exclude the sample from scoring (auditor downtime must not
   * mass-zero correctness for everyone).
   */
  | "auditor_unavailable"
  | "freshness_stale"
  | "correctness_failure"
  | "reliability_failure";

export type ChallengeStatus =
  /** Challenge dispatched to vantages; correctness decided per-sample in the worker. */
  | "ready"
  | "expired";

export type AssignmentStatus = "unclaimed" | "claimed" | "done" | "expired";

export type Bucket = string;

export interface MethodHandlers<P = unknown, R = unknown> {
  deriveChallenge: (ctx: ChallengeContext) => Promise<{ params: P; bucket: Bucket } | null>;
  project: (response: R) => CanonicalProjection;
  classify: (
    projection: CanonicalProjection,
    reference: CanonicalProjection,
    providerTipSlot: bigint,
    referenceTipSlot: bigint,
    /**
     * Challenge bucket, for the rare handler whose match strictness is
     * bucket-dependent (getSignaturesForAddress: frozen archival windows are
     * byte-equal; tip-anchored windows use the Jaccard trim match).
     */
    bucket?: Bucket,
  ) => Correctness;
  buckets: readonly Bucket[];
  /**
   * Hybrid value methods only (getBalance / getTokenSupply /
   * getTokenAccountBalance). When ≥3 voters formed a panel but no value-
   * majority emerged — i.e. the value churned across the parallel panel reads
   * — the consensus is `ambiguous` even though every provider answered.
   * Rather than drop those samples as `no_consensus`, the runner falls back to
   * a freshness/liveness verdict via this hook (see packages/runner/src/
   * record.ts `decideForMode` / `decideProviderOutcome`). Returns
   * correct | stale | incorrect off the provider's own returned slot.
   * Absent on all other methods (the runner keeps the `no_consensus` drop).
   */
  livenessFallback?: (projection: CanonicalProjection, referenceTipSlot: bigint) => Correctness;
}

export interface ChallengeContext {
  recentSlots: readonly bigint[];
  utility: RpcClient;
  method: Method;
  bucket: Bucket;
}

export interface RpcCallOptions {
  /** Override the client's construction-time timeout for this one call. */
  timeoutMs?: number;
}

export interface RpcClient {
  call: <T>(method: string, params: unknown[], opts?: RpcCallOptions) => Promise<T>;
}

export interface CanonicalProjection {
  hash: Uint8Array;
  shape: unknown;
}
