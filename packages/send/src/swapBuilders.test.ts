/**
 * Regression tests for the swap builders' reverse trade-size + zero guard — the
 * fix for the multi-vantage drain race (swapCommon.ts REVERSE_FANOUT_SPLIT). A
 * full-balance reverse let concurrent vantages drain the shared wallet and revert
 * (ZeroTradableAmount, 60-68% of reverse swaps). PoolRpc is an interface, mocked
 * here. Run: `pnpm --filter @rpcbench/send test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyPairSignerFromPrivateKeyBytes, type Instruction } from "@solana/kit";
import { RaydiumSwapBuilder, RAYDIUM_AMM_V4_PROGRAM } from "./scenarios/raydium.js";
import { OrcaSwapBuilder, ORCA_WHIRLPOOL_PROGRAM } from "./scenarios/orca.js";
import { DEFAULT_RAYDIUM_CONFIG, DEFAULT_ORCA_CONFIG } from "./scenarios/defaultPools.js";
import { readU64LE, REVERSE_FANOUT_SPLIT, type PoolRpc } from "./scenarios/swapCommon.js";

/** Minimal whirlpool account Orca parses: tick_spacing@41, tick_current_index@81,
 *  32-byte vaults@133/@213 (≥245 bytes). */
function whirlpool(): Uint8Array {
  const b = new Uint8Array(245);
  const dv = new DataView(b.buffer);
  dv.setUint16(41, 64, true); // tick_spacing
  dv.setInt32(81, 0, true); // tick_current_index
  b.fill(1, 133, 165); // token_vault_a
  b.fill(2, 213, 245); // token_vault_b
  return b;
}

const mockRpc = (balance: bigint): PoolRpc => ({
  getAccountData: async () => whirlpool(),
  getTokenBalance: async () => balance,
});

const payer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));

const raydium = (rpc: PoolRpc) =>
  new RaydiumSwapBuilder(DEFAULT_RAYDIUM_CONFIG, DEFAULT_RAYDIUM_CONFIG.poolAddress, rpc);
const orca = (rpc: PoolRpc) =>
  new OrcaSwapBuilder(
    DEFAULT_ORCA_CONFIG.poolAddress,
    DEFAULT_ORCA_CONFIG.tokenAMint,
    DEFAULT_ORCA_CONFIG.tokenBMint,
    DEFAULT_ORCA_CONFIG.swapAmountLamports,
    rpc,
  );

/** amount (u64 LE) from the program's swap ix data at `offset`. */
function swapAmount(ixs: readonly Instruction[], program: string, offset: number): bigint {
  const ix = ixs.find((i) => i.programAddress === program);
  assert.ok(ix?.data, "swap instruction not found");
  return readU64LE(ix.data as Uint8Array, offset);
}

test("REVERSE_FANOUT_SPLIT = 2 × VANTAGE_SAMPLE_SIZE (exceeds the fan-out)", () => {
  assert.equal(REVERSE_FANOUT_SPLIT, 6n);
});

test("raydium reverse trades balance / SPLIT (not the full balance)", async () => {
  const built = await raydium(mockRpc(60_000n)).build({ payer, direction: "reverse" });
  assert.ok(built);
  assert.equal(swapAmount(built.instructions, RAYDIUM_AMM_V4_PROGRAM, 1), 60_000n / REVERSE_FANOUT_SPLIT);
});

test("raydium forward trades the fixed swapAmountLamports", async () => {
  const built = await raydium(mockRpc(60_000n)).build({ payer, direction: "forward" });
  assert.ok(built);
  assert.equal(
    swapAmount(built.instructions, RAYDIUM_AMM_V4_PROGRAM, 1),
    BigInt(DEFAULT_RAYDIUM_CONFIG.swapAmountLamports),
  );
});

test("orca reverse trades balance / SPLIT (amount @ offset 8)", async () => {
  const built = await orca(mockRpc(60_000n)).build({ payer, direction: "reverse" });
  assert.ok(built);
  assert.equal(swapAmount(built.instructions, ORCA_WHIRLPOOL_PROGRAM, 8), 60_000n / REVERSE_FANOUT_SPLIT);
});

test("reverse with drained/dust balance is SKIPPED (null), not a ZeroTradableAmount send", async () => {
  for (const bal of [0n, 5n]) {
    // 5 / 6 truncates to 0 — the exact case that reverted before the guard.
    assert.equal(await raydium(mockRpc(bal)).build({ payer, direction: "reverse" }), null);
    assert.equal(await orca(mockRpc(bal)).build({ payer, direction: "reverse" }), null);
  }
});
