/**
 * Transaction assembly + signing via @solana/kit (v2).
 *
 * The repo has no other Solana SDK — this is the single place that builds and
 * signs a real V0 transaction. Instruction order:
 *   (nonce advance + memo)? · setComputeUnitLimit · setComputeUnitPrice
 *     · <scenario instructions> · (tip transfer)?
 *
 * The scored reliability path uses a recent blockhash. One send challenge (shared
 * blockhash + payload) fans to multiple vantages that share a wallet, so without
 * disambiguation every vantage would sign the byte-identical message → the SAME
 * signature → collision (send_pending PK) + no per-vantage attribution. We fold a
 * per-vantage nonce into the compute-unit LIMIT (the tx-landing-canary technique):
 * `setComputeUnitLimit(limit + cuNonce)` makes the message differ per vantage at
 * ZERO extra compute — no memo, no ~10.5k-CU SPL Memo invocation. Per-target
 * wallets already distinguish signatures ACROSS targets; the CU nonce distinguishes
 * them ACROSS vantages.
 *
 * The optional head-to-head win-rate axis uses a shared durable nonce + a
 * per-target memo salt instead (so signatures differ while compute cost is
 * identical). Only THAT path incurs NONCE_CU_OVERHEAD — never the scored path.
 */

import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  getAdvanceNonceAccountInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import type { SendTip } from "@rpcbench/shared";

/** CU overhead added when the tx carries an advance-nonce + memo (race axis ONLY). */
export const NONCE_CU_OVERHEAD = 7_500;
/** CU overhead added when the tx carries a tip transfer (a bare SystemProgram transfer). */
export const TIP_CU_OVERHEAD = 300;

export interface BuildTxParams {
  /** Fee payer + sole signer (per-target wallet on the scored path). */
  payer: KeyPairSigner;
  /** Shared recent-blockhash value for the tick (fairness, not a nonce race). */
  recentBlockhash: string;
  lastValidBlockHeight: bigint;
  /** Scenario instructions (transfer / swap), already resolved. */
  instructions: readonly Instruction[];
  computeUnitLimit: number;
  /** Priority fee in micro-lamports per CU (adaptive, uniform across targets). */
  priorityFeeMicroLamports: number;
  /** Per-target tip (directed to the path's tip account); omit for tip-less relays. */
  tip?: SendTip | undefined;
  /**
   * Signature-uniqueness nonce for the scored (recent-blockhash) path, folded
   * into the compute-unit LIMIT (`setComputeUnitLimit(computeUnitLimit + cuNonce)`)
   * — the tx-landing-canary technique. One challenge fans to several vantages
   * that share a wallet + blockhash + payload; a distinct nonce per vantage makes
   * the signed message (and thus the signature) differ, so send_pending's PK
   * doesn't collide and each vantage is attributable. This costs ZERO extra
   * compute (a higher limit only raises the ceiling; nothing runs) — unlike a
   * memo, which invokes the ~10.5k-CU SPL Memo program. Derive it from the full
   * vantage triple (see `vantageCuNonce`). Ignored when `nonce` is set.
   */
  cuNonce?: number | undefined;
  /**
   * Optional durable-nonce race context (win-rate axis only). When present, an
   * advanceNonceAccount + a per-target memo salt are prepended and the blockhash
   * lifetime is derived from the nonce rather than `recentBlockhash`.
   */
  nonce?: {
    nonceAccount: string;
    nonceAuthority: KeyPairSigner;
    /** The nonce's stored blockhash value. */
    nonceBlockhash: string;
    /** Base64 memo salt so signatures differ across targets sharing the nonce. */
    memoSalt: string;
  };
}

export interface BuiltTx {
  /** Base64-encoded wire transaction for `sendTransaction`. */
  base64: string;
  /** The transaction signature (matches the confirm stream). */
  signature: string;
}

/**
 * Assemble + sign the transaction. Returns the base64 wire form (for submit)
 * and the signature (registered in send_pending before submit).
 */
export async function buildAndSignTx(params: BuildTxParams): Promise<BuiltTx> {
  const {
    payer,
    instructions,
    computeUnitLimit,
    priorityFeeMicroLamports,
    tip,
    cuNonce,
    nonce,
  } = params;

  const head: Instruction[] = [];
  if (nonce) {
    head.push(
      getAdvanceNonceAccountInstruction({
        nonceAccount: address(nonce.nonceAccount),
        nonceAuthority: nonce.nonceAuthority,
      }),
    );
    head.push(getAddMemoInstruction({ memo: nonce.memoSalt }));
  }
  // Scored path: fold the per-vantage nonce into the CU limit so vantages sharing
  // one blockhash + wallet get distinct signatures (canary technique, zero extra
  // compute). Ignored on the nonce-race path (its memo salt already disambiguates).
  head.push(
    getSetComputeUnitLimitInstruction({
      units: computeUnitLimit + (nonce ? 0 : (cuNonce ?? 0)),
    }),
  );
  head.push(
    getSetComputeUnitPriceInstruction({
      microLamports: BigInt(priorityFeeMicroLamports),
    }),
  );

  const tail: Instruction[] = [];
  if (tip) {
    tail.push(
      getTransferSolInstruction({
        source: payer,
        destination: address(tip.account),
        amount: lamports(BigInt(tip.lamports)),
      }),
    );
  }

  const allIxs: Instruction[] = [...head, ...instructions, ...tail];

  // Blockhash lifetime: nonce's stored blockhash for the race, else the shared
  // recent blockhash. Both are branded `Blockhash` at the type layer.
  const blockhash = (nonce?.nonceBlockhash ?? params.recentBlockhash) as Blockhash;

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight: params.lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions(allIxs, m),
  );

  const signed = await signTransactionMessageWithSigners(message);
  return {
    base64: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  };
}
