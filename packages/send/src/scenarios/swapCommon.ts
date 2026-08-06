/**
 * Shared swap helpers: LE encoders, ATA derivation, wrap-SOL instructions, and
 * the config shape the Raydium/Orca builders consume.
 *
 * Design note (hand-rolled swaps): rather than fragile on-chain byte-offset
 * parsing at runtime, the benchmark pool's sub-accounts (vaults, market keys,
 * tick arrays, …) are supplied as an ORDERED config — they are constants for a
 * fixed benchmark pool. The builder derives only the per-payer user ATAs at
 * build time and assembles the instruction with the correct program id +
 * discriminator + amount encoding. The ordered `accounts` list encodes the
 * program's account layout (each entry marks writable/signer); finalize the
 * exact order + addresses against the Raydium AMM v4 / Orca Whirlpool IDL and
 * the chosen pool during integration.
 */

import {
  AccountRole,
  address,
  createSolanaRpc,
  getAddressDecoder,
  type AccountMeta,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { lamports } from "@solana/kit";

/** Native SOL mint (wrapped SOL). */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Minimal on-chain read surface the swap builders need to resolve pool state.
 * Raydium reads a token balance (full-balance reverse swaps); Orca additionally
 * reads the whirlpool account to derive price-dependent tick arrays each build.
 */
export interface PoolRpc {
  /** Raw account data bytes (throws if the account doesn't exist). */
  getAccountData(addr: string): Promise<Uint8Array>;
  /** SPL token account balance in base units (0 if missing/unreadable). */
  getTokenBalance(ata: string): Promise<bigint>;
}

/** Adapt a @solana/kit RPC into the `PoolRpc` surface. */
export function kitPoolRpc(rpc: ReturnType<typeof createSolanaRpc>): PoolRpc {
  return {
    async getAccountData(addr: string): Promise<Uint8Array> {
      const res = await rpc.getAccountInfo(address(addr), { encoding: "base64" }).send();
      const data = res.value?.data;
      if (!data) throw new Error(`account not found: ${addr}`);
      return new Uint8Array(Buffer.from(data[0], "base64"));
    },
    async getTokenBalance(ata: string): Promise<bigint> {
      try {
        const res = await rpc.getTokenAccountBalance(address(ata)).send();
        return BigInt(res.value.amount);
      } catch {
        return 0n;
      }
    },
  };
}

const ADDRESS_DECODER = getAddressDecoder();
/** Read a 32-byte pubkey at `offset` as a base58 address. */
export function readPubkey(data: Uint8Array, offset: number): string {
  return ADDRESS_DECODER.decode(data.subarray(offset, offset + 32));
}
export function readU64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}
export function readI32LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, true);
}
export function readU16LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, true);
}

/** Little-endian u64 as 8 bytes. */
export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/** One account in a swap config's ordered account list. */
export interface SwapAccountSpec {
  address: string;
  writable?: boolean;
  signer?: boolean;
}

/** Common config across both AMMs. `accounts` is the program's ordered layout. */
export interface SwapConfig {
  programId: string;
  swapAmountLamports: number;
  /** The two token mints; direction picks source/dest. */
  tokenAMint: string;
  tokenBMint: string;
  /** Ordered program accounts (vaults, market/whirlpool keys, authorities, …). */
  accounts: readonly SwapAccountSpec[];
}

/** Convert a SwapAccountSpec to a kit AccountMeta. */
export function toMeta(a: SwapAccountSpec): AccountMeta {
  const role = a.signer
    ? a.writable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : a.writable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY;
  return { address: address(a.address), role };
}

/** Derive the payer's associated token account for a mint. */
export async function ata(owner: Address, mint: string): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner,
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return pda;
}

/**
 * Prelude instructions ensuring the payer's source/dest ATAs exist, and (if the
 * source is native SOL) wrapping `amount` lamports into the WSOL ATA + syncing.
 */
export async function ataAndWrapIxs(
  payer: KeyPairSigner,
  sourceMint: string,
  destMint: string,
  amountLamports: number,
): Promise<{ sourceAta: Address; destAta: Address; ixs: Instruction[] }> {
  const sourceAta = await ata(payer.address, sourceMint);
  const destAta = await ata(payer.address, destMint);
  const ixs: Instruction[] = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      owner: payer.address,
      mint: address(sourceMint),
      ata: sourceAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      owner: payer.address,
      mint: address(destMint),
      ata: destAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ];
  if (sourceMint === WSOL_MINT) {
    ixs.push(
      getTransferSolInstruction({
        source: payer,
        destination: sourceAta,
        amount: lamports(BigInt(amountLamports)),
      }),
      getSyncNativeInstruction({ account: sourceAta }),
    );
  }
  return { sourceAta, destAta, ixs };
}

/** Build a raw instruction from program id, ordered metas, and data bytes. */
export function rawInstruction(
  programId: string,
  accounts: readonly AccountMeta[],
  data: Uint8Array,
): Instruction {
  return { programAddress: address(programId), accounts: [...accounts], data };
}
