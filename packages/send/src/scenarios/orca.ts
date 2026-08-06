/**
 * Orca Whirlpool swap — faithful port of the observatory's `scenario/orca.rs`.
 *
 * Program: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc.
 * Anchor `swap` discriminator (8 bytes) + args:
 *   amount (u64), other_amount_threshold (u64), sqrt_price_limit (u128),
 *   amount_specified_is_input (bool), a_to_b (bool).
 *
 * Unlike Raydium, the whirlpool's tick arrays are PRICE-DEPENDENT: they're PDAs
 * derived from the pool's live `tick_current_index`, so they can't be a static
 * config. Each build fetches the whirlpool account, parses tick spacing / current
 * index / vaults, and derives the oracle + the 3 tick arrays in the swap
 * direction. The account layout (11) matches the Whirlpool `swap` IDL exactly:
 * token program, authority(payer), whirlpool, owner_a, vault_a, owner_b, vault_b,
 * tick_array_0/1/2, oracle — with the user ATAs in FIXED a/b order (direction is
 * carried in the instruction data, not the account order).
 */

import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type Instruction,
  type ReadonlyUint8Array,
  lamports,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import type { Scenario } from "@rpcbench/shared";
import type { BuildContext, BuiltTransaction, ScenarioBuilder } from "./types.js";
import { SCENARIO_CU_LIMIT } from "./types.js";
import {
  ata,
  rawInstruction,
  u64le,
  readU16LE,
  readI32LE,
  readPubkey,
  WSOL_MINT,
  REVERSE_FANOUT_SPLIT,
  type PoolRpc,
} from "./swapCommon.js";

export const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
// Anchor discriminator for the `swap` instruction (sha256("global:swap")[..8]).
const SWAP_DISCRIMINATOR = new Uint8Array([248, 198, 158, 145, 225, 117, 135, 200]);
// sqrt price limits (Q64.64) — the whirlpool min/max tick sqrt prices.
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;
const TICK_ARRAY_SIZE = 88;

// Whirlpool account byte offsets (port of orca.rs).
const TICK_SPACING_OFFSET = 41;
const TICK_CURRENT_INDEX_OFFSET = 81;
const TOKEN_VAULT_A_OFFSET = 133;
const TOKEN_VAULT_B_OFFSET = 213;
const WHIRLPOOL_MIN_SIZE = 245;

const ADDRESS_ENCODER = getAddressEncoder();

/** Encode a little-endian u128 as 16 bytes. */
function u128le(n: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, n & 0xffffffffffffffffn, true);
  dv.setBigUint64(8, n >> 64n, true);
  return b;
}

async function derivePda(
  program: string,
  seeds: (string | ReadonlyUint8Array)[],
): Promise<string> {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(program), seeds });
  return pda;
}

/** The 3 tick arrays a swap crosses, in direction order (port of compute_tick_arrays). */
async function tickArrays(
  program: string,
  whirlpool: string,
  tickCurrentIndex: number,
  tickSpacing: number,
  aToB: boolean,
): Promise<[string, string, string]> {
  const ticksInArray = TICK_ARRAY_SIZE * tickSpacing;
  const start = Math.floor(tickCurrentIndex / ticksInArray) * ticksInArray;
  const steps = aToB
    ? [start, start - ticksInArray, start - 2 * ticksInArray]
    : [start, start + ticksInArray, start + 2 * ticksInArray];
  const wpBytes = ADDRESS_ENCODER.encode(address(whirlpool));
  const [a, b, c] = await Promise.all(
    steps.map((s) => derivePda(program, ["tick_array", wpBytes, String(s)])),
  );
  return [a!, b!, c!];
}

export class OrcaSwapBuilder implements ScenarioBuilder {
  readonly name: Scenario = "orca_swap";
  private readonly poolAddr: string;
  private readonly tokenA: string;
  private readonly tokenB: string;
  private readonly swapAmountLamports: number;
  private readonly rpc: PoolRpc;
  private readonly program: string;

  constructor(
    poolAddress: string,
    tokenAMint: string,
    tokenBMint: string,
    swapAmountLamports: number,
    rpc: PoolRpc,
    program: string = ORCA_WHIRLPOOL_PROGRAM,
  ) {
    this.poolAddr = poolAddress;
    this.tokenA = tokenAMint;
    this.tokenB = tokenBMint;
    this.swapAmountLamports = swapAmountLamports;
    this.rpc = rpc;
    this.program = program;
  }

  poolAddress(): string {
    return this.poolAddr;
  }

  writeLockAccounts(): readonly string[] {
    return [this.poolAddr];
  }

  async build(ctx: BuildContext): Promise<BuiltTransaction | null> {
    const data = await this.rpc.getAccountData(this.poolAddr);
    if (data.length < WHIRLPOOL_MIN_SIZE) {
      throw new Error(`whirlpool account too short: ${data.length} bytes`);
    }
    const tickSpacing = readU16LE(data, TICK_SPACING_OFFSET);
    const tickCurrentIndex = readI32LE(data, TICK_CURRENT_INDEX_OFFSET);
    const tokenVaultA = readPubkey(data, TOKEN_VAULT_A_OFFSET);
    const tokenVaultB = readPubkey(data, TOKEN_VAULT_B_OFFSET);

    const aToB = ctx.direction === "forward";
    // ATAs are ALWAYS in a/b order in the account list; direction is in the data.
    const ataA = await ata(ctx.payer.address, this.tokenA);
    const ataB = await ata(ctx.payer.address, this.tokenB);
    const [sourceAta, sourceMint] = aToB ? [ataA, this.tokenA] : [ataB, this.tokenB];

    // Native-SOL source swaps the fixed lamport amount (freshly wrapped below).
    // A token source (reverse) swaps only balance / REVERSE_FANOUT_SPLIT, NOT the
    // full balance: several vantages share this wallet, so a full-balance dump
    // lets the first drain it and the rest revert with ZeroTradableAmount. The
    // fractional slice keeps concurrent reverses independent + inventory bounded.
    const amount =
      sourceMint === WSOL_MINT
        ? BigInt(this.swapAmountLamports)
        : (await this.rpc.getTokenBalance(sourceAta)) / REVERSE_FANOUT_SPLIT;
    // Integer division truncates: a drained/empty (or <SPLIT) counter-token
    // balance yields 0 → skip rather than send a ZeroTradableAmount revert.
    if (amount === 0n) return null;

    const oracle = await derivePda(this.program, [
      "oracle",
      ADDRESS_ENCODER.encode(address(this.poolAddr)),
    ]);
    const [tick0, tick1, tick2] = await tickArrays(
      this.program,
      this.poolAddr,
      tickCurrentIndex,
      tickSpacing,
      aToB,
    );

    // instruction data: discriminator(8) + amount(8) + threshold(8)
    //   + sqrt_price_limit(16) + amount_specified_is_input(1) + a_to_b(1)
    const ixData = new Uint8Array(8 + 8 + 8 + 16 + 1 + 1);
    let o = 0;
    ixData.set(SWAP_DISCRIMINATOR, o); o += 8;
    ixData.set(u64le(amount), o); o += 8;
    ixData.set(u64le(0n), o); o += 8; // other_amount_threshold = 0
    ixData.set(u128le(aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE), o); o += 16;
    ixData[o] = 1; o += 1; // amount_specified_is_input = true
    ixData[o] = aToB ? 1 : 0; // a_to_b

    const metas: AccountMeta[] = [
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ctx.payer.address, role: AccountRole.READONLY_SIGNER },
      { address: address(this.poolAddr), role: AccountRole.WRITABLE },
      { address: ataA, role: AccountRole.WRITABLE },
      { address: address(tokenVaultA), role: AccountRole.WRITABLE },
      { address: ataB, role: AccountRole.WRITABLE },
      { address: address(tokenVaultB), role: AccountRole.WRITABLE },
      { address: address(tick0), role: AccountRole.WRITABLE },
      { address: address(tick1), role: AccountRole.WRITABLE },
      { address: address(tick2), role: AccountRole.WRITABLE },
      { address: address(oracle), role: AccountRole.WRITABLE },
    ];
    const swapIx = rawInstruction(this.program, metas, ixData);

    // Prelude: ensure both ATAs exist; if source is native SOL, wrap the amount.
    const ixs: Instruction[] = [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: ctx.payer,
        owner: ctx.payer.address,
        mint: address(this.tokenA),
        ata: ataA,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      getCreateAssociatedTokenIdempotentInstruction({
        payer: ctx.payer,
        owner: ctx.payer.address,
        mint: address(this.tokenB),
        ata: ataB,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ];
    if (sourceMint === WSOL_MINT) {
      ixs.push(
        getTransferSolInstruction({
          source: ctx.payer,
          destination: sourceAta,
          amount: lamports(amount),
        }),
        getSyncNativeInstruction({ account: sourceAta }),
      );
    }
    ixs.push(swapIx);

    return {
      instructions: ixs,
      writeLockAccounts: [this.poolAddr],
      computeUnitLimit: SCENARIO_CU_LIMIT.orca_swap,
    };
  }
}
