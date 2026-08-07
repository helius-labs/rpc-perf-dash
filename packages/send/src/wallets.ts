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
import { executeRows, type DbClient } from "@rpcbench/db";
import {
  address,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getBase64Encoder,
  getBase64Decoder,
  lamports,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { SEND_TARGET_CONFIGS, type Scenario } from "@rpcbench/shared";
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
      // transferLamports returns confirmed?; only count the top-up (budget + funded set)
      // if it actually landed. A sent-but-unconfirmed transfer is left unfunded this tick
      // — next tick re-reads the balance and retries if it still didn't land.
      const ok = await transferLamports(rpc, master, w.signer.address, opts.topupLamports);
      if (ok) {
        remaining -= opts.topupLamports;
        funded.add(w.signer.address);
      } else {
        console.warn(`[send/funding] top-up unconfirmed for ${w.name}; will retry next tick`);
      }
    } catch (err) {
      console.warn(`[send/funding] top-up failed for ${w.name}: ${String(err)}`);
    }
  }
  return funded;
}

/**
 * Build + sign `instructions` from `payer`, send, and poll ~30s for confirmation.
 * Returns `true` iff a confirmed/finalized status was seen — callers that mutate
 * on-chain state (harvest close/sweep) MUST check it and not assume the tx landed.
 * `computeUnitLimit` + `priorityFeeMicroLamports` are REQUIRED: a System transfer
 * fits in 500 CU, but `closeAccount` (~3k) and swaps (80k–150k) do not.
 */
export async function sendAndConfirmIxs(
  rpc: Rpc<SolanaRpcApi>,
  payer: KeyPairSigner,
  instructions: Instruction[],
  opts: { computeUnitLimit: number; priorityFeeMicroLamports: number },
): Promise<boolean> {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const { base64 } = await buildAndSignTx({
    payer,
    recentBlockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    computeUnitLimit: opts.computeUnitLimit,
    priorityFeeMicroLamports: opts.priorityFeeMicroLamports,
    instructions,
  });
  const sig = await rpc
    .sendTransaction(base64 as never, { encoding: "base64", skipPreflight: false })
    .send();
  for (let i = 0; i < 30; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/** Compute-unit limit + priority price for a System transfer (funding top-up / sweep). */
const TRANSFER_CU_LIMIT = 500;
const TRANSFER_PRIORITY_MICRO = 1_000;
/**
 * The EXACT fee `transferLamports` pays: 5_000 base (one signature) + the priority fee
 * `ceil(CU × µlamports/CU / 1e6)`. This is deterministic — Solana derives it from the
 * tx itself, not the market — so a sweep can drain a wallet to *exactly* 0. That
 * matters: leaving any dust (0 < balance < the rent-exempt minimum) makes the bank
 * reject the tx with `InsufficientFundsForRent`. Derived from the constants above so it
 * can never drift from what `transferLamports` actually pays.
 */
export const TRANSFER_FEE_LAMPORTS =
  5_000n + BigInt(Math.ceil((TRANSFER_CU_LIMIT * TRANSFER_PRIORITY_MICRO) / 1_000_000));

/** Send a simple SOL transfer from `from` to `to` (thin wrapper over
 *  `sendAndConfirmIxs`; a System transfer fits in 500 CU). Returns confirmed?. */
export async function transferLamports(
  rpc: Rpc<SolanaRpcApi>,
  from: KeyPairSigner,
  to: string,
  amount: bigint,
): Promise<boolean> {
  return sendAndConfirmIxs(
    rpc,
    from,
    [getTransferSolInstruction({ source: from, destination: address(to), amount: lamports(amount) })],
    { computeUnitLimit: TRANSFER_CU_LIMIT, priorityFeeMicroLamports: TRANSFER_PRIORITY_MICRO },
  );
}

/** Load (creating on first use) the per-(target × scenario) payer signers for the
 *  given scenarios — the wallet list the funding tick iterates. */
export async function loadSendWallets(
  registry: KeyRegistry,
  scenarios: readonly Scenario[],
): Promise<{ name: string; signer: KeyPairSigner }[]> {
  const wallets: { name: string; signer: KeyPairSigner }[] = [];
  for (const cfg of SEND_TARGET_CONFIGS) {
    for (const scenario of scenarios) {
      const name = `${cfg.name}:${scenario}`;
      wallets.push({
        name,
        signer: await registry.loadOrCreate(name, "payer", { scenario, sendTarget: cfg.name }),
      });
    }
  }
  return wallets;
}

/**
 * The send target a payer wallet belongs to — the persisted `send_target` column, falling
 * back to the name prefix (`"<target>:<scenario>"`) only when it's null (a hand-inserted
 * row; both real writers always set the column). This single value decides roster (keep)
 * vs orphan (drain-to-0), so it's a named, unit-tested helper rather than an inline split.
 */
export function sendTargetOf(w: { name: string; sendTarget: string | null }): string {
  return w.sendTarget ?? w.name.split(":")[0] ?? "";
}

/**
 * Load every EXISTING payer wallet from `send_wallets` as signers — **never creates**
 * (derives the signer from the persisted `secret_ref`). Harvest iterates this and
 * partitions it into roster vs orphan by target; unlike `loadSendWallets` it must not
 * mint fresh keypairs for target×scenario combos that were never funded/used.
 */
export async function loadExistingPayers(
  db: DbClient,
): Promise<{ name: string; sendTarget: string | null; signer: KeyPairSigner }[]> {
  const rows = await executeRows<{ name: string; send_target: string | null; secret_ref: string }>(
    db,
    sql`SELECT name, send_target, secret_ref FROM send_wallets WHERE role = 'payer'`,
  );
  const wallets: { name: string; sendTarget: string | null; signer: KeyPairSigner }[] = [];
  for (const row of rows) {
    const seed = getBase64Encoder().encode(row.secret_ref);
    wallets.push({
      name: row.name,
      sendTarget: row.send_target,
      signer: await createKeyPairSignerFromPrivateKeyBytes(seed),
    });
  }
  return wallets;
}

export { createSolanaRpc };
