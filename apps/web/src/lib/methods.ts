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
