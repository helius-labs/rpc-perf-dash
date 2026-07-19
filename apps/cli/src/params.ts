/**
 * Map a handler's per-method param object (the `params` returned by
 * deriveChallenge) to the positional JSON-RPC params array.
 *
 * Copied verbatim from apps/generator/src/params.ts to keep the CLI standalone.
 * If you edit one, edit both — they must not drift. Pure (no I/O/env/secret/DB).
 * NOTE: every method needs an explicit branch — the final fallthrough is the
 * getSignaturesForAddress shape ([address, options]).
 */
import type { Method } from "@rpcbench/shared";

export function paramsAsArray(method: Method, p: unknown): unknown[] {
  if (method === "getBlock") {
    const x = p as { slot: number; options: unknown };
    return [x.slot, x.options];
  }
  if (method === "getTransaction") {
    const x = p as { signature: string; options: unknown };
    return [x.signature, x.options];
  }
  if (method === "getSlot") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getAccountInfo") {
    const x = p as { pubkey: string; options: unknown };
    return [x.pubkey, x.options];
  }
  if (method === "getProgramAccounts") {
    const x = p as { programId: string; options: unknown };
    return [x.programId, x.options];
  }
  if (method === "getTokenAccountsByOwner") {
    const x = p as { owner: string; filter: unknown; options: unknown };
    return [x.owner, x.filter, x.options];
  }
  if (method === "getBalance") {
    const x = p as { pubkey: string; options: unknown };
    return [x.pubkey, x.options];
  }
  if (method === "getSupply") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getTokenSupply") {
    const x = p as { mint: string; options: unknown };
    return [x.mint, x.options];
  }
  if (method === "getTokenLargestAccounts") {
    const x = p as { mint: string; options: unknown };
    return [x.mint, x.options];
  }
  if (method === "getLatestBlockhash") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getTokenAccountBalance") {
    const x = p as { tokenAccount: string; options: unknown };
    return [x.tokenAccount, x.options];
  }
  // No-param methods.
  if (
    method === "getGenesisHash" ||
    method === "getEpochSchedule" ||
    method === "getInflationGovernor" ||
    method === "getInflationRate" ||
    method === "getMaxRetransmitSlot" ||
    method === "getMaxShredInsertSlot" ||
    method === "getIdentity" ||
    method === "getVersion" ||
    method === "getHealth" ||
    method === "getStakeMinimumDelegation" ||
    method === "getRecentPrioritizationFees" ||
    method === "getClusterNodes"
  ) {
    return [];
  }
  if (method === "getBlockTime") {
    const x = p as { slot: number };
    return [x.slot];
  }
  if (method === "getBlockCommitment") {
    const x = p as { slot: number };
    return [x.slot];
  }
  if (method === "getBlocks") {
    const x = p as { startSlot: number; endSlot: number };
    return [x.startSlot, x.endSlot];
  }
  if (method === "getInflationReward") {
    const x = p as { addresses: string[]; options: unknown };
    return [x.addresses, x.options];
  }
  if (method === "getLeaderSchedule") {
    const x = p as { slot: number; options: unknown };
    return [x.slot, x.options];
  }
  if (method === "getBlockProduction") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getEpochInfo") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getBlockHeight") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getTransactionCount") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getVoteAccounts") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getRecentPerformanceSamples") {
    const x = p as { limit: number };
    return [x.limit];
  }
  if (method === "isBlockhashValid") {
    const x = p as { blockhash: string; options: unknown };
    return [x.blockhash, x.options];
  }
  if (method === "getSlotLeader") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getSlotLeaders") {
    const x = p as { startSlot: number; limit: number };
    return [x.startSlot, x.limit];
  }
  if (method === "simulateTransaction") {
    const x = p as { tx: string; options: unknown };
    return [x.tx, x.options];
  }
  if (method === "simulateBundle") {
    const x = p as { bundle: unknown; options: unknown };
    return [x.bundle, x.options];
  }
  if (method === "getMultipleAccounts") {
    const x = p as { pubkeys: string[]; options: unknown };
    return [x.pubkeys, x.options];
  }
  if (method === "getSignatureStatuses") {
    const x = p as { signatures: string[]; options: unknown };
    return [x.signatures, x.options];
  }
  if (method === "getMinimumBalanceForRentExemption") {
    const x = p as { dataSize: number };
    return [x.dataSize];
  }
  if (method === "getBlocksWithLimit") {
    const x = p as { startSlot: number; limit: number };
    return [x.startSlot, x.limit];
  }
  if (method === "getLargestAccounts") {
    const x = p as { options: unknown };
    return [x.options];
  }
  if (method === "getFeeForMessage") {
    const x = p as { message: string; options: unknown };
    return [x.message, x.options];
  }
  if (method === "getTransactionsForAddress") {
    const x = p as { address: string; options: unknown };
    return [x.address, x.options];
  }
  // getSignaturesForAddress
  const x = p as { address: string; options: unknown };
  return [x.address, x.options];
}
