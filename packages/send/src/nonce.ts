/**
 * Durable-nonce helpers — used ONLY by the optional head-to-head win-rate axis
 * (a shared nonce race). The scored reliability path uses a recent blockhash and
 * never touches this. Per-scenario nonce account + authority; the stored nonce
 * blockhash is read from the account data.
 */

import {
  address,
  getBase58Decoder,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  getCreateAccountInstruction,
  getInitializeNonceAccountInstruction,
} from "@solana-program/system";

/** System program address + nonce account rent-exempt size. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** `nonce::State::size()` — Nonce account data length. */
export const NONCE_ACCOUNT_SIZE = 80;

/**
 * Parse the stored blockhash from a durable-nonce account's data.
 * Layout: version(u32) · state(u32) · authority(Pubkey,32) · blockhash(32) · fee.
 * The blockhash starts at byte offset 40.
 */
export function parseNonceBlockhash(data: Uint8Array): string {
  if (data.length < 72) throw new Error("nonce: account data too short");
  const bytes = data.subarray(40, 72);
  return getBase58Decoder().decode(bytes);
}

/** Instructions to create + initialize a durable-nonce account. */
export function createNonceAccountIxs(params: {
  payer: KeyPairSigner;
  nonceAccount: KeyPairSigner;
  nonceAuthority: string;
  rentLamports: bigint;
}): Instruction[] {
  return [
    getCreateAccountInstruction({
      payer: params.payer,
      newAccount: params.nonceAccount,
      lamports: params.rentLamports,
      space: BigInt(NONCE_ACCOUNT_SIZE),
      programAddress: address(SYSTEM_PROGRAM),
    }),
    getInitializeNonceAccountInstruction({
      nonceAccount: params.nonceAccount.address,
      nonceAuthority: address(params.nonceAuthority),
    }),
  ];
}
