/**
 * Transfer scenario: a SOL self-send (payer → payer). The cheapest, most
 * deterministic scenario — no pool, no token accounts. CU limit 500.
 */

import { getTransferSolInstruction } from "@solana-program/system";
import { lamports } from "@solana/kit";
import type { Scenario } from "@rpcbench/shared";
import type { BuildContext, BuiltTransaction, ScenarioBuilder } from "./types.js";
import { SCENARIO_CU_LIMIT } from "./types.js";

/** Default self-send amount (lamports) — matches the observatory default. */
const TRANSFER_AMOUNT_LAMPORTS = 5_000;

export class TransferBuilder implements ScenarioBuilder {
  readonly name: Scenario = "transfer";
  private readonly amount: number;

  constructor(amountLamports = TRANSFER_AMOUNT_LAMPORTS) {
    this.amount = amountLamports;
  }

  poolAddress(): string | null {
    return null;
  }

  writeLockAccounts(): readonly string[] {
    return [];
  }

  async build(ctx: BuildContext): Promise<BuiltTransaction> {
    const ix = getTransferSolInstruction({
      source: ctx.payer,
      destination: ctx.payer.address,
      amount: lamports(BigInt(this.amount)),
    });
    return {
      instructions: [ix],
      writeLockAccounts: [],
      computeUnitLimit: SCENARIO_CU_LIMIT.transfer,
    };
  }
}
