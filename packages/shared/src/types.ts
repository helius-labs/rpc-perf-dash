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
  // Additional read methods. See docs/methodology.md "Projection &
  // equivalence" for each method's archetype.
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
  // Custom indexer-backed address-history method (Helius/Triton/Alchemy;
  // QuickNode serves a non-comparable variant → 3-voter panel). Slot-pinned
  // challenges, strict byte-equal — Archetype A:
  | "getTransactionsForAddress";

/**
 * Methods the generator emits as challenges. Single source of truth for both
 * the generator's dispatch loop and the benchmark CLI so the two can't drift.
 */
export const EMITTED_METHODS: readonly Method[] = [
  "getBlock",
  "getTransaction",
  "getSignaturesForAddress",
  "getSlot",
  "getAccountInfo",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getBalance",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getLatestBlockhash",
  "getTokenAccountBalance",
  "getGenesisHash",
  "getEpochSchedule",
  "getInflationGovernor",
  "getInflationRate",
  "getBlockTime",
  "getBlockCommitment",
  "getBlocks",
  "getInflationReward",
  "getLeaderSchedule",
  "getBlockProduction",
  "getMaxRetransmitSlot",
  "getMaxShredInsertSlot",
  "getEpochInfo",
  "getBlockHeight",
  "getTransactionCount",
  "getVoteAccounts",
  "getRecentPerformanceSamples",
  "getIdentity",
  "getVersion",
  "getHealth",
  "isBlockhashValid",
  "getSlotLeader",
  "getSlotLeaders",
  "simulateTransaction",
  "simulateBundle",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getMinimumBalanceForRentExemption",
  "getStakeMinimumDelegation",
  "getBlocksWithLimit",
  "getRecentPrioritizationFees",
  "getFeeForMessage",
  "getTransactionsForAddress",
] as const;

/**
 * Registered handlers that are intentionally NOT emitted — they can't reach the
 * 3-voter consensus minimum on the current panel (see docs/methodology.md).
 * Handlers stay registered so in-flight straggler challenges still resolve, and
 * re-enabling is a matter of moving one entry into EMITTED_METHODS. getSupply is
 * fully dormant; getClusterNodes / getLargestAccounts stay CLI-testable for
 * re-validation (see the benchmark CLI).
 */
export const DORMANT_METHODS: readonly Method[] = [
  "getSupply",
  "getClusterNodes",
  "getLargestAccounts",
] as const;

export type Region = string;

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
  },
};

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

/** Rollup grain: the 5-min hot tier, or the '1h'/'1d' grains of the merged
 *  `rollups` table. */
export type RollupGrain = "5m" | "1h" | "1d";

/**
 * Map a requested window (hours) to the coarsest ROLLUP grain that still
 * satisfies the latency CHART: ≤6h → 5-min, ≤7d → hourly, >7d → daily. The 24h
 * view reads hourly (not 5-min) — a 5-min scan of the large rollups_5m table for
 * the all-vantage Overview is far slower than the hourly grain, and the chart's
 * client-side re-binner already coarsens, so 24h simply shows hourly points.
 */
export function rollupGrainForWindow(windowHours: number): RollupGrain {
  if (windowHours <= 6) return "5m";
  if (windowHours <= 168) return "1h";
  return "1d";
}

/**
 * Resolve a window to the rollup SOURCE for a chart read. The 5-min tier is its
 * own table (rollups_5m) with NO grain column; the hourly/daily tiers share the
 * merged `rollups` table, filtered by grain. Returns a validated constant table
 * name (never user input, safe to splice via sql.raw) plus the grain to filter
 * on — null for rollups_5m.
 */
export function rollupSourceForWindow(
  windowHours: number,
): { table: "rollups_5m" | "rollups"; grain: "1h" | "1d" | null } {
  const grain = rollupGrainForWindow(windowHours);
  return grain === "5m" ? { table: "rollups_5m", grain: null } : { table: "rollups", grain };
}

/**
 * Map a window to the LEADERBOARD precompute grain (≤7d → '1h', >7d → '1d'). All
 * four precompute tables (leaderboard_agg / leaderboard_challenges /
 * leaderboard_failures / latency_histogram) are single merged tables
 * discriminated by this grain; the precompute is refreshed every 5 min, so it
 * serves all windows, not just long ones.
 */
export function leaderboardGrainForWindow(windowHours: number): "1h" | "1d" {
  return windowHours <= 168 ? "1h" : "1d";
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
  /**
   * No usable majority among the benchmarked-panel voters for this
   * (challenge, vantage, mode). Sample drops from both correctness and
   * reliability denominators.
   */
  | "no_consensus"
  | "freshness_stale"
  | "correctness_failure"
  | "reliability_failure"
  /**
   * No-fault exclusions — dropped from BOTH the correctness and reliability
   * denominators (like tier_method_unsupported), not counted against the
   * provider. Because the rollup `success_rate` averages `status='ok' AND
   * correctness!='ambiguous'` over ALL rows, an `ambiguous` sample otherwise
   * *lowers* reliability; these two reasons are additionally filtered out of the
   * reliability numerator+denominator on both eligibility gates (see
   * apps/generator/src/rollup.ts success_rate FILTER + leaderboard_agg
   * nofault_excluded_count). Both carry correctness='ambiguous'.
   */
  /**
   * Mutable-value method (getBalance, getAccountInfo, …) diverged from the panel
   * consensus while reading a strictly NEWER slot than the majority — a fresher
   * read, not a wrong one. No ground truth exists at the newer slot, so it's
   * excluded rather than scored. See packages/methods/src/freshness.ts
   * valueDivergenceVerdict.
   */
  | "freshness_ahead"
  /**
   * Operator-side operational error (billing quota / rate-limit) returned as an
   * HTTP-200 JSON-RPC error body. It's the benchmark account's own credit cap,
   * not a provider data or availability defect, so it's no-fault.
   */
  | "operational_error";

export type ChallengeStatus =
  /** Challenge dispatched to vantages; correctness decided per-sample in the worker. */
  | "ready"
  | "expired";

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

// ════════════════════════════════════════════════════════════════════════
// Transaction-sending ("sends") archetype
//
// A parallel benchmark to the read path: instead of scoring RPC responses by
// cross-provider consensus, we broadcast real transactions through competing
// send paths and score them against the chain (landed / reverted / not-landed /
// submit-error). See docs/methodology.md § Transaction sends.
// ════════════════════════════════════════════════════════════════════════

/**
 * Top-level discriminator carried on `challenges` / `challenge_assignments`.
 * `read` = the consensus-scored RPC benchmark; `send` = the landing benchmark.
 * The fan-out / claim / vantage machinery is archetype-agnostic; the worker
 * branches on this, not on `method`.
 */
export type Archetype = "read" | "send";

/** The transaction shapes we send each tick. */
export type Scenario = "transfer" | "raydium_swap" | "orca_swap";
export const SCENARIOS: readonly Scenario[] = ["transfer", "raydium_swap", "orca_swap"];

/** Swap direction, flipped each tick to conserve token inventory. */
export type SwapDirection = "forward" | "reverse";

/**
 * Send targets == the benchmarked read RPC providers. A send-target id EQUALS
 * its provider id: each read `ProviderRow` also carries `sends: true` +
 * `send_endpoints`. We measure plain JSON-RPC `sendTransaction` across every
 * provider's standard endpoint (no tips, no relays, no premium send paths) — an
 * apples-to-apples landing comparison.
 */
export type SendTargetId = "helius" | "alchemy" | "triton" | "quicknode" | "chainstack";

export const SEND_TARGET_IDS: readonly SendTargetId[] = [
  "helius",
  "alchemy",
  "triton",
  "quicknode",
  "chainstack",
];

/**
 * Chain-truth outcome for a single send, decided by the confirmation service.
 *   landed       — confirmed on-chain, no execution error (success).
 *   reverted     — landed WITH an on-chain error (meta.err != null); still a
 *                  successful landing for reliability, published as a diagnostic.
 *   not_landed   — never seen by the reaper (~80s); reliability miss.
 *   submit_error — the target's submit endpoint rejected/failed the HTTP call.
 */
export type SendOutcome = "landed" | "reverted" | "not_landed" | "submit_error";
export const SEND_OUTCOMES: readonly SendOutcome[] = [
  "landed",
  "reverted",
  "not_landed",
  "submit_error",
];

/** Wire protocol of a send path. We only measure plain JSON-RPC sendTransaction. */
export type SendProtocol = "jsonrpc";

/** A tip transfer appended to the tx, directed to a path-specific account. */
export interface SendTip {
  /** Base58 tip account (per-target). */
  account: string;
  lamports: number;
}

/**
 * Full send-path config (port of the observatory `SendTargetConfig`). A bare
 * URL is insufficient — relays need per-target auth headers/queries and a tip
 * account. `url`/`headers`/`queries` values may contain `env:VAR` placeholders
 * (resolved by resolveEndpointUrl) and `{region}`-style templates filled from
 * the worker's WORKER_REGION via a per-vendor region→POP map.
 */
export interface SendTargetConfig {
  /** Stable target id, also the `send_target` column value. */
  name: SendTargetId;
  /** Endpoint URL (may hold `env:VAR` + `{region}` template tokens). */
  url: string;
  /** Extra HTTP headers (auth etc.); values may be `env:VAR`. */
  headers?: Record<string, string>;
  /** Query params appended to the URL; values may be `env:VAR`. */
  queries?: Record<string, string>;
  /** Per-target tip account + lamports; omitted for tip-less relays. */
  tip?: SendTip;
  protocol: SendProtocol;
}

/**
 * Params for a send challenge (analogous to a read challenge's `params`). All
 * targets in a tick share these — same blockhash value, CU limit, priority fee,
 * payload — but each signs from its own wallet, so all can land independently.
 */
export interface SendChallengeParams {
  scenario: Scenario;
  /** Shared recent-blockhash value for the tick (fairness, not a nonce race). */
  recent_blockhash: string;
  /** Last valid block height for the shared blockhash (tx lifetime). */
  last_valid_block_height: number;
  compute_unit_limit: number;
  /** In-effect adaptive priority fee (µlamports/CU); uniform across targets. */
  priority_fee: number;
  swap_direction?: SwapDirection | undefined;
  /**
   * Set ONLY for the optional shared-nonce win-rate axis; null on the scored
   * reliability path. Groups racers that share one durable nonce.
   */
  nonce_race_id?: string | null;
}

/**
 * In-flight send registry row (`send_pending`, PK=signature). `slot_sent` is
 * deliberately absent — the confirm service assigns it on its own slot clock.
 */
export interface SendPendingRow {
  signature: string;
  challenge_id: string;
  scenario: Scenario;
  send_target: SendTargetId;
  worker_provider: string;
  region: string;
  egress_path: string;
  sent_at: Date;
  submit_latency_ms: number | null;
  nonce_race_id: string | null;
  priority_fee: number;
  tip_amount: number;
  cu_requested: number;
  pool_address: string | null;
  swap_direction: SwapDirection | null;
}

/** Final classified send row (`landing_tx_results`, append-only). */
export interface LandingTxResultRow {
  challenge_id: string;
  scenario: Scenario;
  send_target: SendTargetId;
  worker_provider: string;
  region: string;
  egress_path: string;
  signature: string;
  outcome: SendOutcome;
  landed: boolean;
  failed: boolean;
  submit_error: string | null;
  started_at: Date;
  sent_at: Date;
  submit_latency_ms: number | null;
  wall_latency_ms: number | null;
  slot_sent: bigint | null;
  slot_landed: bigint | null;
  slot_latency: bigint | null;
  nonce_race_id: string | null;
  priority_fee: number;
  tip_amount: number;
  cu_requested: number;
  cu_used: bigint | null;
  pool_address: string | null;
  swap_direction: SwapDirection | null;
  methodology_version: number;
}

/** Low-balance alert feed (`landing_wallet_balances`). */
export interface LandingWalletBalanceRow {
  started_at: Date;
  region: string;
  target_name: string;
  balance_lamports: bigint;
}
