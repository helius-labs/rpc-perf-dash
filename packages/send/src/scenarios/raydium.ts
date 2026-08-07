/**
 * Raydium AMM v4 swap (`swap_base_in`, instruction tag 9).
 *
 * Program: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8.
 * data = [9, amount_in (u64 LE), min_amount_out (u64 LE = 0)].
 *
 * The pool/market accounts are supplied as an ORDERED config (constants for the
 * benchmark pool — see swapCommon.ts). The user's source/dest ATAs + owner are
 * appended after them, matching swap_base_in's account order (…, uer_source,
 * user_dest, user_owner). Direction flips which mint is source vs dest.
 */

import { AccountRole, type AccountMeta } from "@solana/kit";
import type { Scenario } from "@rpcbench/shared";
import type { BuildContext, BuiltTransaction, ScenarioBuilder } from "./types.js";
import { SCENARIO_CU_LIMIT } from "./types.js";
import {
  rawInstruction,
  toMeta,
  u64le,
  ataAndWrapIxs,
  WSOL_MINT,
  REVERSE_FANOUT_SPLIT,
  type PoolRpc,
  type SwapConfig,
} from "./swapCommon.js";

export const RAYDIUM_AMM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const SWAP_BASE_IN_TAG = 9;

export class RaydiumSwapBuilder implements ScenarioBuilder {
  readonly name: Scenario = "raydium_swap";
  private readonly cfg: SwapConfig;
  private readonly poolAddr: string;
  private readonly rpc: PoolRpc;

  constructor(cfg: SwapConfig, poolAddress: string, rpc: PoolRpc) {
    this.cfg = cfg;
    this.poolAddr = poolAddress;
    this.rpc = rpc;
  }

  poolAddress(): string {
    return this.poolAddr;
  }

  writeLockAccounts(): readonly string[] {
    return [this.poolAddr];
  }

  async build(ctx: BuildContext): Promise<BuiltTransaction | null> {
    // Direction: forward = A→B, reverse = B→A.
    const [sourceMint, destMint] =
      ctx.direction === "forward"
        ? [this.cfg.tokenAMint, this.cfg.tokenBMint]
        : [this.cfg.tokenBMint, this.cfg.tokenAMint];

    const { sourceAta, destAta, ixs } = await ataAndWrapIxs(
      ctx.payer,
      sourceMint,
      destMint,
      this.cfg.swapAmountLamports,
    );

    // Amount: a native-SOL source swaps the fixed lamport amount (freshly
    // wrapped above). A token source (reverse) swaps only balance /
    // REVERSE_FANOUT_SPLIT, NOT the full balance: several vantages share this
    // wallet, so a full-balance dump lets the first drain it and the rest revert
    // with ZeroTradableAmount. The fractional slice keeps concurrent reverses
    // independent + inventory bounded.
    const amount =
      sourceMint === WSOL_MINT
        ? BigInt(this.cfg.swapAmountLamports)
        : (await this.rpc.getTokenBalance(sourceAta)) / REVERSE_FANOUT_SPLIT;
    // Integer division truncates: a drained/empty (or <SPLIT) counter-token
    // balance yields 0 → skip rather than send a ZeroTradableAmount revert.
    if (amount === 0n) return null;

    // data: tag(1) + amount_in(8) + min_amount_out(8)
    const data = new Uint8Array(17);
    data[0] = SWAP_BASE_IN_TAG;
    data.set(u64le(amount), 1);
    data.set(u64le(0n), 9); // min_amount_out = 0 (benchmark: don't fail on slippage)

    // Account order = the faithful Raydium AMM v4 swap_base_in layout (17):
    // cfg.accounts is the 14 pool/market accounts (token program … vault signer,
    // NO target_orders), then user source, user dest, owner.
    const metas: AccountMeta[] = [
      ...this.cfg.accounts.map(toMeta),
      { address: sourceAta, role: AccountRole.WRITABLE },
      { address: destAta, role: AccountRole.WRITABLE },
      { address: ctx.payer.address, role: AccountRole.READONLY_SIGNER },
    ];

    const swapIx = rawInstruction(this.cfg.programId, metas, data);
    return {
      instructions: [...ixs, swapIx],
      writeLockAccounts: [this.poolAddr],
      computeUnitLimit: SCENARIO_CU_LIMIT.raydium_swap,
    };
  }
}
