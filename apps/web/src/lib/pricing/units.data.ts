/**
 * Per-method native-unit cost tables, one per benchmarked provider.
 *
 * `default` covers any method not in `byMethod` so we don't enumerate all 45
 * methods per provider. `unsupported` is NOT authored here — it's derived from
 * providers.ts `unsupported_methods` at simulate time. Undocumented per-method
 * costs are modeled as `default: {kind:"unknown"}` (Alchemy) — never guessed.
 *
 * Verified 2026-06-12 against each provider's public docs (source_url below).
 */

import type { Method } from "@rpcbench/shared";
import type { ProviderUnitTable, UnitCost } from "./types";

const U = (value: number): UnitCost => ({ kind: "units", value });

// Helius: most JSON-RPC calls = 1 credit; getProgramAccounts + archival = 10.
// (DAS / Enhanced Tx / Mint cost more but aren't in the benchmarked method set.)
const HELIUS_UNITS: ProviderUnitTable = {
  providerId: "helius",
  unitName: "credits",
  default: U(1),
  byMethod: {
    getProgramAccounts: U(10),
  },
  note: "Most calls 1 credit; getProgramAccounts 10. A few heavy methods (DAS, Enhanced Transactions, getTransactionsForAddress) cost 10+ but aren't in the benchmarked set; most historical reads are 1 credit.",
  provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-12" },
};

// Alchemy: per-method Compute Units. No single house default — methods absent
// from the published table are left unknown rather than guessed.
const ALCHEMY_UNITS: ProviderUnitTable = {
  providerId: "alchemy",
  unitName: "compute_units",
  default: { kind: "unknown" },
  byMethod: {
    getTransaction: U(40),
    getBlock: U(40),
    getSignaturesForAddress: U(40),
    getSlot: U(20),
    getAccountInfo: U(10),
    getTokenAccountsByOwner: U(10),
    getBalance: U(10),
    getTokenSupply: U(20),
    getTokenLargestAccounts: U(20),
    getLatestBlockhash: U(20),
    getTokenAccountBalance: U(20),
    getGenesisHash: U(10),
    getEpochSchedule: U(20),
    getInflationGovernor: U(20),
    getInflationRate: U(20),
    getBlockTime: U(20),
    getBlocks: U(10),
    getInflationReward: U(40),
    getLeaderSchedule: U(20),
    getMaxRetransmitSlot: U(20),
    getMaxShredInsertSlot: U(20),
    getEpochInfo: U(20),
    getBlockHeight: U(20),
    getTransactionCount: U(20),
    getVoteAccounts: U(20),
    getRecentPerformanceSamples: U(20),
    getIdentity: U(20),
    getVersion: U(20),
    getHealth: U(20),
    isBlockhashValid: U(20),
    getSlotLeader: U(20),
    getSlotLeaders: U(20),
    simulateTransaction: U(20),
    getMultipleAccounts: U(20),
    getSignatureStatuses: U(20),
    getBlocksWithLimit: U(20),
    getRecentPrioritizationFees: U(10),
    getFeeForMessage: U(20),
    getProgramAccounts: U(20),
    // Not in Alchemy's published CU table → unknown (not 0):
    // getBlockCommitment, getBlockProduction, getMinimumBalanceForRentExemption,
    // getTransactionsForAddress, simulateBundle.
  },
  note: "Compute Units per method from Alchemy docs. Methods absent from the table (e.g. getBlockProduction, getTransactionsForAddress) are unknown, not free.",
  provenance: {
    source_url: "https://www.alchemy.com/docs/reference/compute-unit-costs",
    verified_on: "2026-06-12",
  },
};

// QuickNode: flat 30 API credits for standard methods. "Advanced APIs" 2x and
// "Large Calls" 4x multipliers exist but the per-method list isn't published,
// so we use the documented base for all and flag the caveat.
const QUICKNODE_UNITS: ProviderUnitTable = {
  providerId: "quicknode",
  unitName: "api_credits",
  default: U(30),
  byMethod: {},
  note: "Standard methods = 30 credits (already the Solana figure for credit-based billing; the separate 1.5x Solana multiplier applies only to QuickNode's Flat-Rate-RPS model, not API credits). QuickNode applies 2x (Advanced) / 4x (Large Calls) multipliers to some methods, but the per-method list isn't public — base rate used for all; treat heavy methods (getProgramAccounts, getBlock) as a lower bound.",
  hasUnmodeledMultipliers: true,
  // Heavy methods most likely to fall under the 2×/4× bands. Used only to raise
  // a lower-bound caveat when present — never to compute a (guessed) cost.
  multiplierMethods: ["getProgramAccounts", "getBlock", "getTransaction", "getSignaturesForAddress"],
  provenance: { source_url: "https://www.quicknode.com/api-credits", verified_on: "2026-06-12" },
};

// Triton: not credit-based. The "unit" is simply a request count (1/call);
// USD comes from the plan's per-call + bandwidth surcharges.
const TRITON_UNITS: ProviderUnitTable = {
  providerId: "triton",
  unitName: "requests",
  default: U(1),
  byMethod: {},
  note: "Pay-as-you-go: billed per request ($10/1M) + bandwidth ($0.08/GB), not credits.",
  provenance: { source_url: "https://triton.one/pricing/", verified_on: "2026-06-12" },
};

export const PROVIDER_UNIT_TABLES: readonly ProviderUnitTable[] = [
  HELIUS_UNITS,
  ALCHEMY_UNITS,
  QUICKNODE_UNITS,
  TRITON_UNITS,
];

export function unitTableForProvider(providerId: string): ProviderUnitTable | undefined {
  return PROVIDER_UNIT_TABLES.find((t) => t.providerId === providerId);
}

/** Per-call native cost for a method, applying byMethod override then default. */
export function unitsForMethod(table: ProviderUnitTable, method: Method): UnitCost {
  return table.byMethod[method] ?? table.default;
}
