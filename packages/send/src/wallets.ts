/**
 * Wallet key registry + funding (port of `key_registry.rs` + `wallet.rs`).
 *
 * - Per-(send_target × scenario) signing keys, persisted in the `send_wallets`
 *   DB table (workers read them there — NOT Secrets Manager). Auto-generated on
 *   first use by the generator leader.
 * - A fresh, independent benchmark master (`SEND_MASTER_KEYPAIR`, generator-only)
 *   funds them — distinct from the observatory master (no shared drain risk).
 * - Funding tick: top up any wallet below `min_balance_lamports`; record every
 *   balance to `landing_wallet_balances` for the low-balance alert.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";
import {
  address,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getBase64Encoder,
  getBase64Decoder,
  lamports,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { buildAndSignTx } from "./tx.js";

type WalletRole = "payer" | "nonce_authority" | "nonce_account";

/** Parse `SEND_MASTER_KEYPAIR` (a Solana CLI JSON array of 64 bytes). */
export async function loadMasterFromEnv(
  envVar = "SEND_MASTER_KEYPAIR",
): Promise<KeyPairSigner> {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`${envVar} is not set`);
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  if (bytes.length !== 64) throw new Error(`${envVar}: expected 64-byte keypair`);
  return createKeyPairSignerFromBytes(bytes);
}

export class KeyRegistry {
  constructor(private readonly db: DbClient) {}

  /**
   * Load the signing keypair for `name`, creating + persisting it on first use.
   * Only the generator leader should create; workers call with an existing name.
   */
  async loadOrCreate(
    name: string,
    role: WalletRole,
    meta: { scenario?: string; sendTarget?: string } = {},
  ): Promise<KeyPairSigner> {
    const rows = (await this.db.execute(
      sql`SELECT secret_ref FROM send_wallets WHERE name = ${name}`,
    )) as unknown as { secret_ref: string }[];
    if (rows[0]) {
      const seed = getBase64Encoder().encode(rows[0].secret_ref);
      return createKeyPairSignerFromPrivateKeyBytes(seed);
    }
    // Generate a fresh 32-byte ed25519 private seed we can persist.
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const secretRef = getBase64Decoder().decode(seed);
    await this.db.execute(sql`
      INSERT INTO send_wallets (name, pubkey, scenario, send_target, role, secret_ref)
      VALUES (${name}, ${signer.address}, ${meta.scenario ?? null}, ${meta.sendTarget ?? null}, ${role}, ${secretRef})
      ON CONFLICT (name) DO NOTHING
    `);
    return signer;
  }
}

/** Record a wallet balance to the low-balance alert feed. */
export async function recordBalance(
  db: DbClient,
  region: string,
  targetName: string,
  balanceLamports: bigint,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO landing_wallet_balances (region, target_name, balance_lamports)
    VALUES (${region}, ${targetName}, ${balanceLamports})
  `);
}

export interface FundingOptions {
  minBalanceLamports: bigint;
  topupLamports: bigint;
  region: string;
}

/**
 * Top up any wallet below `minBalanceLamports` from the master. Records every
 * balance; skips (and logs) wallets the master can't afford. Returns the set of
 * pubkeys that are funded (≥ min) after this pass — the dispatcher skips others.
 */
export async function runFundingTick(
  db: DbClient,
  rpc: Rpc<SolanaRpcApi>,
  master: KeyPairSigner,
  wallets: { name: string; signer: KeyPairSigner }[],
  opts: FundingOptions,
): Promise<Set<string>> {
  const funded = new Set<string>();
  const masterBalance = (await rpc.getBalance(master.address).send()).value;
  let remaining: bigint = masterBalance;

  for (const w of wallets) {
    const bal = (await rpc.getBalance(w.signer.address).send()).value;
    await recordBalance(db, opts.region, w.name, bal);
    if (bal >= opts.minBalanceLamports) {
      funded.add(w.signer.address);
      continue;
    }
    // Need a top-up. Skip if the master can't afford it (+ a fee cushion).
    if (remaining < opts.topupLamports + 10_000n) {
      console.warn(`[send/funding] master low; skipping top-up for ${w.name}`);
      continue;
    }
    try {
      await transferLamports(rpc, master, w.signer.address, opts.topupLamports);
      remaining -= opts.topupLamports;
      funded.add(w.signer.address); // optimistic; next tick re-reads truth
    } catch (err) {
      console.warn(`[send/funding] top-up failed for ${w.name}: ${String(err)}`);
    }
  }
  return funded;
}

/** Send a simple SOL transfer from `from` to `to` and poll for confirmation. */
async function transferLamports(
  rpc: Rpc<SolanaRpcApi>,
  from: KeyPairSigner,
  to: string,
  amount: bigint,
): Promise<void> {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const { base64 } = await buildAndSignTx({
    payer: from,
    recentBlockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    computeUnitLimit: 500,
    priorityFeeMicroLamports: 1_000,
    instructions: [
      getTransferSolInstruction({
        source: from,
        destination: address(to),
        amount: lamports(amount),
      }),
    ],
  });
  const sig = await rpc
    .sendTransaction(base64 as never, { encoding: "base64", skipPreflight: false })
    .send();
  // Best-effort confirmation poll (funding is housekeeping, not benchmarked).
  for (let i = 0; i < 30; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

export { createSolanaRpc };
