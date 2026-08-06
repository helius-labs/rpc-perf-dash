/**
 * Scenario builder framework (port of `scenario/mod.rs`).
 *
 * A builder produces the scenario-specific instructions for a tick, plus the
 * write-lock accounts to monitor for contention and the CU limit. All targets
 * in a tick get the SAME built instructions (fairness); only the fee payer
 * differs (per-target wallet).
 */

import type { Instruction, KeyPairSigner } from "@solana/kit";
import type { Scenario, SwapDirection } from "@rpcbench/shared";

export interface BuildContext {
  /** Per-target fee payer / signer. */
  payer: KeyPairSigner;
  /** Swap direction for this tick (flipped each tick to conserve inventory). */
  direction: SwapDirection;
}

export interface BuiltTransaction {
  instructions: readonly Instruction[];
  /** Write-lock accounts (pool addresses) to monitor for contention. */
  writeLockAccounts: readonly string[];
  computeUnitLimit: number;
}

export interface ScenarioBuilder {
  readonly name: Scenario;
  /** The pool this scenario contends on (null for transfer). */
  poolAddress(): string | null;
  /** Accounts whose contention this scenario cares about (pool address). */
  writeLockAccounts(): readonly string[];
  /** Build the tx, or `null` to skip this target for this tick — e.g. a reverse
   *  swap whose input amount rounds to 0 (drained/empty counter-token balance),
   *  which would otherwise revert with ZeroTradableAmount. The dispatcher drops
   *  null builds before signing/sending. */
  build(ctx: BuildContext): Promise<BuiltTransaction | null>;
}

/** Fixed CU base limits per scenario (a per-vantage nonce ≤4095 is added for
 *  signature uniqueness — see dispatch.ts). Transfer is 1000 (the tx-landing-
 *  canary's proven value for transfer + compute-budget ixs, no memo); swaps
 *  match the observatory and simulate at ~47k/50k, well under budget. */
export const SCENARIO_CU_LIMIT: Record<Scenario, number> = {
  transfer: 1_000,
  raydium_swap: 80_000,
  orca_swap: 150_000,
};
