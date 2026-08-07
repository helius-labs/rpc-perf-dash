/**
 * Harvest / SOL recovery (inverse of the funding tick, `wallets.ts`).
 *
 * Forward swaps wrap native SOL → WSOL → USDC; reverses convert USDC → WSOL that
 * is never unwrapped, so native SOL migrates one-way into each wallet's WSOL
 * account and the master drains via top-ups. Harvest closes that loop:
 *
 * - **Roster wallets** (still-configured targets, NOT the env-filtered send set — a
 *   scenario disabled this deploy still holds WSOL): CLOSE the WSOL ATA → rent + wrapped
 *   balance return to the wallet as native, so funding stops topping it up (the burn
 *   drops). Sweep only *genuine excess* native (above a ceiling, leaving a float ≥ the
 *   funding min) back to the master — rarely fires by design.
 * - **Orphan wallets** (payer rows for retired targets): unwrap (always — reclaims the
 *   ~2.04M-lamport ATA rent even at 0 wrapped balance, since orphans are never reused),
 *   then drain native to the master down to *exactly 0* so the account is purged.
 *
 * Runs on the generator leader on its own interval. Best-effort per wallet; every
 * on-chain step is gated on confirmation (see `sendAndConfirmIxs`). Harvest does NOT
 * touch USDC (kept small by reverses) — see docs/methodology.md § Transaction sends.
 */

import { sql } from "drizzle-orm";
import { getCloseAccountInstruction } from "@solana-program/token";
import { type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { executeRows, type DbClient } from "@rpcbench/db";
import { ata, WSOL_MINT, kitPoolRpc } from "./scenarios/swapCommon.js";
import { recordBalance, sendAndConfirmIxs, transferLamports, TRANSFER_FEE_LAMPORTS } from "./wallets.js";

/** Compute-unit limit for a `closeAccount` unwrap tx — the instruction costs ~3k CU; 5k
 *  is a safe margin (≈5 lamports of priority fee at 1k µlamports/CU). */
const CLOSE_CU_LIMIT = 5_000;
/** Priority fee for harvest txs — low; harvest is not latency-sensitive and its whole
 *  point is reducing burn. Negligible at these CU limits. */
const PRIORITY_FEE = 1_000;
/** Rent-exempt minimum for a 0-data system account (`rent.minimum_balance(0)` = 128 bytes
 *  overhead × 3480 lamports/byte-year × 2 years). Solana's `validate_fee_payer` checks the
 *  fee payer's balance AFTER the fee but BEFORE the instruction runs: it must be 0 or ≥
 *  this, else the tx is rejected with `InsufficientFundsForRent`. */
const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
/** Rent-exempt reserve of a 165-byte SPL token account — the native SOL a `closeAccount`
 *  returns to the wallet ON TOP of the wrapped balance. (128 + 165) × 3480 × 2. Counted so
 *  the recovery log reflects real SOL reclaimed even when the wrapped balance is 0. */
const WSOL_ATA_RENT_LAMPORTS = 2_039_280n;

export interface HarvestOptions {
  region: string;
  /** Only close a *roster* WSOL ATA at/above this (rent is net-neutral over
   *  close→recreate; below this the tx fee isn't worth it). Orphans ignore this — they
   *  close whenever the ATA exists, to reclaim its rent. */
  minWsolLamports: bigint;
  /** Float to LEAVE in a roster wallet when sweeping excess (≥ funding min, so a
   *  swept wallet never drops into the top-up band → no sweep↔topup churn). */
  activeFloorLamports: bigint;
  /** Sweep a roster wallet's native to the master only when it exceeds this
   *  (> funding refill band, so this fires only on genuine excess). */
  sweepCeilingLamports: bigint;
}

/**
 * Pure sweep decision: lamports to transfer to the master (0 = no sweep), given a
 * wallet's post-unwrap native balance. This is the one piece with money semantics, so
 * it's extracted and unit-tested.
 *
 * - **Roster:** sweep only when native exceeds `sweepCeilingLamports` (genuine excess);
 *   the transfer nets the tx fee so the wallet lands at *exactly* `activeFloorLamports`.
 * - **Orphan:** drain to *exactly 0* — transfer `native − fee` (the source pays the fee,
 *   so the balance lands at 0 and the account is purged, reclaiming its rent). But skip
 *   an orphan whose *post-fee* balance would land in `(0, RENT_EXEMPT_MIN)`:
 *   `validate_fee_payer` checks that balance BEFORE the transfer instruction runs and
 *   rejects it (`InsufficientFundsForRent`), so such a wallet can't be drained in one tx
 *   — sweeping it would just error-loop every tick. Unreachable for a closed orphan (the
 *   WSOL ATA rent alone returns ~2.03M), so this only parks a tiny never-wrapped dust.
 */
export function sweepAmount(
  nativeLamports: bigint,
  isOrphan: boolean,
  opts: { activeFloorLamports: bigint; sweepCeilingLamports: bigint },
): bigint {
  if (isOrphan) {
    const drained = nativeLamports - TRANSFER_FEE_LAMPORTS;
    return drained >= RENT_EXEMPT_MIN_LAMPORTS ? drained : 0n;
  }
  if (nativeLamports <= opts.sweepCeilingLamports) return 0n;
  const amount = nativeLamports - opts.activeFloorLamports - TRANSFER_FEE_LAMPORTS;
  return amount > 0n ? amount : 0n;
}

export interface HarvestResult {
  processed: number;
  closed: number;
  /** Native SOL genuinely reclaimed by closing WSOL ATAs. For ORPHANS this is the wrapped
   *  balance PLUS the ATA rent (`WSOL_ATA_RENT_LAMPORTS`) — both leave the wallet for good.
   *  For ROSTER it's the wrapped balance only: the rent is net-neutral because the next
   *  forward recreates the ATA, so counting it would overstate recovery. */
  recoveredLamports: bigint;
  sweptLamports: bigint;
  errors: number;
}

/** Heartbeat the `'harvest'` row in `send_service_status` so ops can tell running
 *  (`ready=true`, fresh `beat_at`) from disabled-by-config (`ready=false`) from stuck
 *  (stale `beat_at`). Mirrors `heartbeatConfirm`. */
export async function heartbeatHarvest(db: DbClient, ready: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO send_service_status (service, ready, beat_at)
    VALUES ('harvest', ${ready}, now())
    ON CONFLICT (service) DO UPDATE SET ready = ${ready}, beat_at = now()
  `);
}

/** Ms since the last **successful (`ready=true`)** `'harvest'` tick, or null if none —
 *  the caller uses it to decide whether to kick at startup. Filtering on `ready` is what
 *  makes re-enabling harvest (after `HARVEST_ENABLED=false` or a bad-threshold disable,
 *  both of which leave a fresh `ready=false` row) kick immediately instead of deferring
 *  up to a full interval because a disabled row's `beat_at` looked recent. */
export async function harvestBeatAgeMs(db: DbClient): Promise<number | null> {
  const rows = await executeRows<{ age_ms: number | string }>(
    db,
    sql`SELECT EXTRACT(EPOCH FROM (now() - beat_at)) * 1000 AS age_ms
        FROM send_service_status WHERE service = 'harvest' AND ready`,
  );
  return rows[0] ? Number(rows[0].age_ms) : null;
}

/**
 * Harvest every roster wallet (unwrap-in-place + rare excess sweep) and every orphan
 * (unwrap + full drain to master). The caller loads the existing payer rows from the DB
 * and partitions them by target: `rosterWallets` are still-configured targets,
 * `orphanWallets` are retired ones. Best-effort — a per-wallet failure is logged and
 * skipped, never thrown.
 */
export async function runHarvestTick(
  db: DbClient,
  rpc: Rpc<SolanaRpcApi>,
  rosterWallets: { name: string; signer: KeyPairSigner }[],
  orphanWallets: { name: string; signer: KeyPairSigner }[],
  master: KeyPairSigner,
  opts: HarvestOptions,
): Promise<HarvestResult> {
  const pool = kitPoolRpc(rpc as Parameters<typeof kitPoolRpc>[0]);
  const result: HarvestResult = {
    processed: 0,
    closed: 0,
    recoveredLamports: 0n,
    sweptLamports: 0n,
    errors: 0,
  };

  const harvestOne = async (
    w: { name: string; signer: KeyPairSigner },
    isOrphan: boolean,
  ): Promise<void> => {
    result.processed += 1;
    // 1. Unwrap: close the WSOL ATA → rent + wrapped balance become native in the wallet.
    const wsolAta = await ata(w.signer.address, WSOL_MINT);
    const wsol = await pool.getTokenBalance(wsolAta); // 0n if the ATA doesn't exist OR holds 0
    // Roster: close only when the wrapped balance clears the fee (avoid close↔recreate
    // churn on the next forward). Orphan: close whenever the ATA *exists* — never reused,
    // so reclaim the ~2.04M-lamport ATA rent even at 0 balance. getTokenBalance can't tell
    // "no ATA" from "0 balance", so for an orphan reporting 0 we confirm existence.
    let doClose = isOrphan ? true : wsol >= opts.minWsolLamports;
    if (isOrphan && wsol === 0n) {
      const info = await rpc.getAccountInfo(wsolAta, { encoding: "base64" }).send();
      doClose = info.value !== null;
    }
    if (doClose) {
      const confirmed = await sendAndConfirmIxs(
        rpc,
        w.signer,
        [
          getCloseAccountInstruction({
            account: wsolAta,
            destination: w.signer.address, // rent + wrapped SOL → native, same wallet
            owner: w.signer,
          }),
        ],
        { computeUnitLimit: CLOSE_CU_LIMIT, priorityFeeMicroLamports: PRIORITY_FEE },
      );
      if (!confirmed) {
        // Do NOT log a recovery or sweep on an unconfirmed unwrap — retry next tick.
        console.warn(`[send/harvest] unwrap unconfirmed for ${w.name} (${wsol} lamports); skipping`);
        result.errors += 1;
        return;
      }
      result.closed += 1;
      // Orphan: wrapped + rent both leave the wallet for good. Roster: rent is net-neutral
      // (the next forward recreates the ATA), so count only the wrapped balance.
      const rent = isOrphan ? WSOL_ATA_RENT_LAMPORTS : 0n;
      const recovered = wsol + rent;
      result.recoveredLamports += recovered;
      console.log(
        `[send/harvest] ${w.name}: closed WSOL ATA → recovered ${recovered} lamports ` +
          `(${wsol} wrapped${isOrphan ? ` + ${rent} rent` : ""})`,
      );
    }

    // 2/3. Sweep to master. Roster: only genuine excess above the ceiling, leaving the
    // active float. Orphan: everything (drain to exactly 0 → account purged). Read at the
    // `confirmed` commitment so we see the post-unwrap balance; a stale-low read would
    // leave dust and the orphan drain would fail the rent check (self-heals next tick).
    const native = (await rpc.getBalance(w.signer.address, { commitment: "confirmed" }).send()).value;
    const amount = sweepAmount(native, isOrphan, opts);
    if (amount > 0n) {
      const ok = await transferLamports(rpc, w.signer, master.address, amount);
      if (ok) {
        result.sweptLamports += amount;
        console.log(`[send/harvest] ${w.name}: swept ${amount} lamports → master`);
      } else {
        console.warn(`[send/harvest] sweep unconfirmed for ${w.name} (${amount} lamports)`);
        result.errors += 1;
      }
    }

    // Record post-harvest native for roster wallets only (healthy value). Orphans are
    // drained to 0 by design; recording them would pollute the low-balance feed. Re-read
    // only if we actually swept — otherwise `native` is already the current post-unwrap
    // balance (the common roster case), so reuse it and skip the extra RPC.
    if (!isOrphan) {
      const post =
        amount > 0n
          ? (await rpc.getBalance(w.signer.address, { commitment: "confirmed" }).send()).value
          : native;
      await recordBalance(db, opts.region, w.name, post);
    }
  };

  for (const w of rosterWallets) {
    try {
      await harvestOne(w, false);
    } catch (err) {
      console.error(`[send/harvest] roster ${w.name}:`, (err as Error).message);
      result.errors += 1;
    }
  }
  for (const w of orphanWallets) {
    try {
      await harvestOne(w, true);
    } catch (err) {
      console.error(`[send/harvest] orphan ${w.name}:`, (err as Error).message);
      result.errors += 1;
    }
  }

  // Record the master balance each tick so the PR's success criterion — "top-ups go quiet,
  // master decline flattens toward the fee floor" — is a SQL question, not a CloudWatch
  // one: `SELECT balance_lamports, started_at FROM landing_wallet_balances WHERE
  // target_name='master' ORDER BY started_at`. Best-effort; a read failure just skips it.
  let masterBalance: bigint | null = null;
  try {
    masterBalance = (await rpc.getBalance(master.address, { commitment: "confirmed" }).send()).value;
    await recordBalance(db, opts.region, "master", masterBalance);
  } catch (err) {
    console.warn(`[send/harvest] master balance record failed:`, (err as Error).message);
  }

  console.log(
    `[send/harvest] done: processed=${result.processed} closed=${result.closed} ` +
      `recovered=${result.recoveredLamports} swept=${result.sweptLamports} errors=${result.errors} ` +
      `master=${masterBalance ?? "?"}`,
  );

  // Heartbeat ready=true because the tick COMPLETED — not `errors === 0`. Per-wallet
  // errors are transient and expected (a single flaky confirm shouldn't flip the service
  // red); they're in the log line above. This keeps `ready=false` meaning exactly
  // "disabled by config" (see the generator's threshold-assert branch), so the ops verify
  // query can tell misconfig from stuck (stale beat_at). Best-effort: a heartbeat write
  // failure must not discard the tick's on-chain work.
  try {
    await heartbeatHarvest(db, true);
  } catch (err) {
    console.warn(`[send/harvest] heartbeat write failed:`, (err as Error).message);
  }
  return result;
}
