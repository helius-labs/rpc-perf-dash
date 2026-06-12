import * as getBlock from "./getBlock.js";
import * as getTransaction from "./getTransaction.js";
import * as getSignaturesForAddress from "./getSignaturesForAddress.js";
import * as getSlot from "./getSlot.js";
import * as getAccountInfo from "./getAccountInfo.js";
import * as getProgramAccounts from "./getProgramAccounts.js";
import * as getTokenAccountsByOwner from "./getTokenAccountsByOwner.js";
import * as getBalance from "./getBalance.js";
import * as getSupply from "./getSupply.js";
import * as getTokenSupply from "./getTokenSupply.js";
import * as getTokenLargestAccounts from "./getTokenLargestAccounts.js";
import * as getLatestBlockhash from "./getLatestBlockhash.js";
import * as getTokenAccountBalance from "./getTokenAccountBalance.js";
// ── Batch added 2026-05-31 ──────────────────────────────────────────
import * as getGenesisHash from "./getGenesisHash.js";
import * as getEpochSchedule from "./getEpochSchedule.js";
import * as getInflationGovernor from "./getInflationGovernor.js";
import * as getInflationRate from "./getInflationRate.js";
import * as getBlockTime from "./getBlockTime.js";
import * as getBlockCommitment from "./getBlockCommitment.js";
import * as getBlocks from "./getBlocks.js";
import * as getInflationReward from "./getInflationReward.js";
import * as getLeaderSchedule from "./getLeaderSchedule.js";
import * as getBlockProduction from "./getBlockProduction.js";
import * as getMaxRetransmitSlot from "./getMaxRetransmitSlot.js";
import * as getMaxShredInsertSlot from "./getMaxShredInsertSlot.js";
import * as getEpochInfo from "./getEpochInfo.js";
import * as getBlockHeight from "./getBlockHeight.js";
import * as getTransactionCount from "./getTransactionCount.js";
import * as getVoteAccounts from "./getVoteAccounts.js";
import * as getRecentPerformanceSamples from "./getRecentPerformanceSamples.js";
import * as getIdentity from "./getIdentity.js";
import * as getVersion from "./getVersion.js";
import * as getHealth from "./getHealth.js";
import * as isBlockhashValid from "./isBlockhashValid.js";
import * as getSlotLeader from "./getSlotLeader.js";
import * as getSlotLeaders from "./getSlotLeaders.js";
import * as simulateTransaction from "./simulateTransaction.js";
import * as simulateBundle from "./simulateBundle.js";
// ── Batch added 2026-06-01 ──────────────────────────────────────────
import * as getMultipleAccounts from "./getMultipleAccounts.js";
import * as getSignatureStatuses from "./getSignatureStatuses.js";
import * as getMinimumBalanceForRentExemption from "./getMinimumBalanceForRentExemption.js";
import * as getStakeMinimumDelegation from "./getStakeMinimumDelegation.js";
import * as getBlocksWithLimit from "./getBlocksWithLimit.js";
import * as getRecentPrioritizationFees from "./getRecentPrioritizationFees.js";
import * as getClusterNodes from "./getClusterNodes.js";
import * as getLargestAccounts from "./getLargestAccounts.js";
import * as getFeeForMessage from "./getFeeForMessage.js";
import * as freshness from "./freshness.js";
import type { Method, MethodHandlers } from "@rpcbench/shared";

export {
  getBlock,
  getTransaction,
  getSignaturesForAddress,
  getSlot,
  getAccountInfo,
  getProgramAccounts,
  getTokenAccountsByOwner,
  getBalance,
  getSupply,
  getTokenSupply,
  getTokenLargestAccounts,
  getLatestBlockhash,
  getTokenAccountBalance,
  getGenesisHash,
  getEpochSchedule,
  getInflationGovernor,
  getInflationRate,
  getBlockTime,
  getBlockCommitment,
  getBlocks,
  getInflationReward,
  getLeaderSchedule,
  getBlockProduction,
  getMaxRetransmitSlot,
  getMaxShredInsertSlot,
  getEpochInfo,
  getBlockHeight,
  getTransactionCount,
  getVoteAccounts,
  getRecentPerformanceSamples,
  getIdentity,
  getVersion,
  getHealth,
  isBlockhashValid,
  getSlotLeader,
  getSlotLeaders,
  simulateTransaction,
  simulateBundle,
  getMultipleAccounts,
  getSignatureStatuses,
  getMinimumBalanceForRentExemption,
  getStakeMinimumDelegation,
  getBlocksWithLimit,
  getRecentPrioritizationFees,
  getClusterNodes,
  getLargestAccounts,
  getFeeForMessage,
  freshness,
};

export const HANDLERS: Record<Method, MethodHandlers<unknown, unknown>> = {
  getBlock: getBlock.handlers as MethodHandlers<unknown, unknown>,
  getTransaction: getTransaction.handlers as MethodHandlers<unknown, unknown>,
  getSignaturesForAddress: getSignaturesForAddress.handlers as MethodHandlers<unknown, unknown>,
  getSlot: getSlot.handlers as MethodHandlers<unknown, unknown>,
  getAccountInfo: getAccountInfo.handlers as MethodHandlers<unknown, unknown>,
  getProgramAccounts: getProgramAccounts.handlers as MethodHandlers<unknown, unknown>,
  getTokenAccountsByOwner: getTokenAccountsByOwner.handlers as MethodHandlers<unknown, unknown>,
  getBalance: getBalance.handlers as MethodHandlers<unknown, unknown>,
  getSupply: getSupply.handlers as MethodHandlers<unknown, unknown>,
  getTokenSupply: getTokenSupply.handlers as MethodHandlers<unknown, unknown>,
  getTokenLargestAccounts: getTokenLargestAccounts.handlers as MethodHandlers<unknown, unknown>,
  getLatestBlockhash: getLatestBlockhash.handlers as MethodHandlers<unknown, unknown>,
  getTokenAccountBalance: getTokenAccountBalance.handlers as MethodHandlers<unknown, unknown>,
  getGenesisHash: getGenesisHash.handlers as MethodHandlers<unknown, unknown>,
  getEpochSchedule: getEpochSchedule.handlers as MethodHandlers<unknown, unknown>,
  getInflationGovernor: getInflationGovernor.handlers as MethodHandlers<unknown, unknown>,
  getInflationRate: getInflationRate.handlers as MethodHandlers<unknown, unknown>,
  getBlockTime: getBlockTime.handlers as MethodHandlers<unknown, unknown>,
  getBlockCommitment: getBlockCommitment.handlers as MethodHandlers<unknown, unknown>,
  getBlocks: getBlocks.handlers as MethodHandlers<unknown, unknown>,
  getInflationReward: getInflationReward.handlers as MethodHandlers<unknown, unknown>,
  getLeaderSchedule: getLeaderSchedule.handlers as MethodHandlers<unknown, unknown>,
  getBlockProduction: getBlockProduction.handlers as MethodHandlers<unknown, unknown>,
  getMaxRetransmitSlot: getMaxRetransmitSlot.handlers as MethodHandlers<unknown, unknown>,
  getMaxShredInsertSlot: getMaxShredInsertSlot.handlers as MethodHandlers<unknown, unknown>,
  getEpochInfo: getEpochInfo.handlers as MethodHandlers<unknown, unknown>,
  getBlockHeight: getBlockHeight.handlers as MethodHandlers<unknown, unknown>,
  getTransactionCount: getTransactionCount.handlers as MethodHandlers<unknown, unknown>,
  getVoteAccounts: getVoteAccounts.handlers as MethodHandlers<unknown, unknown>,
  getRecentPerformanceSamples: getRecentPerformanceSamples.handlers as MethodHandlers<unknown, unknown>,
  getIdentity: getIdentity.handlers as MethodHandlers<unknown, unknown>,
  getVersion: getVersion.handlers as MethodHandlers<unknown, unknown>,
  getHealth: getHealth.handlers as MethodHandlers<unknown, unknown>,
  isBlockhashValid: isBlockhashValid.handlers as MethodHandlers<unknown, unknown>,
  getSlotLeader: getSlotLeader.handlers as MethodHandlers<unknown, unknown>,
  getSlotLeaders: getSlotLeaders.handlers as MethodHandlers<unknown, unknown>,
  simulateTransaction: simulateTransaction.handlers as MethodHandlers<unknown, unknown>,
  simulateBundle: simulateBundle.handlers as MethodHandlers<unknown, unknown>,
  getMultipleAccounts: getMultipleAccounts.handlers as MethodHandlers<unknown, unknown>,
  getSignatureStatuses: getSignatureStatuses.handlers as MethodHandlers<unknown, unknown>,
  getMinimumBalanceForRentExemption: getMinimumBalanceForRentExemption.handlers as MethodHandlers<unknown, unknown>,
  getStakeMinimumDelegation: getStakeMinimumDelegation.handlers as MethodHandlers<unknown, unknown>,
  getBlocksWithLimit: getBlocksWithLimit.handlers as MethodHandlers<unknown, unknown>,
  getRecentPrioritizationFees: getRecentPrioritizationFees.handlers as MethodHandlers<unknown, unknown>,
  getClusterNodes: getClusterNodes.handlers as MethodHandlers<unknown, unknown>,
  getLargestAccounts: getLargestAccounts.handlers as MethodHandlers<unknown, unknown>,
  getFeeForMessage: getFeeForMessage.handlers as MethodHandlers<unknown, unknown>,
};
