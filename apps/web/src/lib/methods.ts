import type { Method } from "@rpcbench/shared";

/**
 * Canonical list of methods the dashboard surfaces (the generator-emitted set;
 * dormant getSupply is excluded). Single source so the home leaderboard chart
 * filter and the /challenges filter never drift — both import this.
 *
 * Display order here is used by the home page's per-method breakdown table; the
 * dropdown filters sort it alphabetically at the call site.
 */
export const ALL_METHODS: Method[] = [
  "getTransaction",
  "getBlock",
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
  // getClusterNodes + getLargestAccounts excluded — dormant (not emitted), like
  // getSupply. See apps/generator/src/index.ts allMethodBucketCombos.
];

/**
 * Named subsets of ALL_METHODS offered as one-click rows in the method
 * dropdowns (below "All methods"). These are workload shortcuts, not scoring
 * presets — they only change which methods are selected, never the weights.
 */
export interface MethodGroup {
  id: string;
  /** Row label + the pill's label when the selection matches this group exactly. */
  label: string;
  /** Tooltip explaining what the group covers. */
  title: string;
  methods: readonly Method[];
}

export const METHOD_GROUPS: readonly MethodGroup[] = [
  {
    id: "archival",
    label: "Archival",
    title:
      "Methods that read old chain data — the seven with an archival bucket (1–2 years back), plus past-epoch rewards and indexer-backed address history.",
    // All but getTransactionsForAddress and getInflationReward emit an
    // `archival` bucket (packages/methods); those two carry no archival bucket
    // but read history all the same (indexer-backed address history / past-epoch
    // rewards).
    //
    // Declaration order matters: the Overview's expanded-row latency grid
    // renders only the first GRID_METHOD_CAP selected methods, so the history
    // reads people actually care about lead and the block-listing variants
    // trail.
    methods: [
      "getTransaction",
      "getBlock",
      "getSignaturesForAddress",
      "getTransactionsForAddress",
      "getBlockTime",
      "getInflationReward",
      "getBlocks",
      "getBlocksWithLimit",
      "getBlockCommitment",
    ],
  },
  {
    id: "account",
    label: "Account-based",
    title: "Account and token-account state reads — the workload an app backend's wallet/portfolio path hits.",
    methods: [
      "getAccountInfo",
      "getMultipleAccounts",
      "getProgramAccounts",
      "getBalance",
      "getTokenAccountsByOwner",
      "getTokenAccountBalance",
      "getTokenSupply",
      "getTokenLargestAccounts",
    ],
  },
];
