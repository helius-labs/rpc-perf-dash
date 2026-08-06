/**
 * Send-lane dispatch (port of `orchestrator.rs::run_tick` + `dispatcher.rs`).
 *
 * One worker fans out to ALL targets for a (scenario, vantage): sign each
 * target's tx from its OWN wallet on the SAME shared blockhash + payload + fee
 * (fairness, independent — all can land), then release them together via a
 * barrier so they hit the network at the same instant.
 *
 * Order of operations (critical): INSERT send_pending BEFORE the HTTP send, so
 * the confirm stream can never match before the pending row exists. On submit
 * error, write the final `landing_tx_results` row (outcome='submit_error') and
 * leave no pending row.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";
import { SEND_METHODOLOGY_VERSION, type SwapDirection } from "@rpcbench/shared";
import type { KeyPairSigner } from "@solana/kit";
import { buildAndSignTx, TIP_CU_OVERHEAD } from "./tx.js";
import type { ScenarioBuilder } from "./scenarios/types.js";
import type { SendTarget } from "./targets/index.js";

/** Range of the per-vantage CU nonce. Only the K vantages sampled for a single
 *  challenge share a blockhash and can collide, so a small range keeps the CU
 *  limit sane while making collisions negligible (~0.07% at K=3). */
const CU_NONCE_RANGE = 4096;

/**
 * Deterministic per-vantage nonce folded into the compute-unit limit so vantages
 * sharing a wallet + blockhash produce distinct signatures (the tx-landing-canary
 * technique — zero extra compute, no memo). Keyed on the FULL vantage triple, not
 * just region, so two backbones sharing a region name (e.g. 'ewr') don't collide.
 */
export function vantageCuNonce(v: {
  worker_provider: string;
  region: string;
  egress_path: string;
}): number {
  const s = `${v.worker_provider}|${v.region}|${v.egress_path}`;
  let h = 2166136261; // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % CU_NONCE_RANGE;
}

export interface DispatchTarget {
  target: SendTarget;
  /** This target's own funded fee-payer wallet (independence). */
  payer: KeyPairSigner;
}

export interface DispatchParams {
  db: DbClient;
  challengeId: string;
  /** Scenario builder — built PER target (instructions embed the target's payer). */
  builder: ScenarioBuilder;
  swapDirection: SwapDirection;
  vantage: { worker_provider: string; region: string; egress_path: string };
  recentBlockhash: string;
  lastValidBlockHeight: bigint;
  /** Head slot at send time (the worker's clock) — the slot_latency zero-point,
   *  the SAME for all targets in this dispatch so cross-target latency is clean. */
  sendSlot: bigint | null;
  /** Adaptive priority fee (µlamports/CU), uniform across targets this tick. */
  priorityFeeMicroLamports: number;
  targets: readonly DispatchTarget[];
}

/** Fire one send challenge across all targets. Returns per-target outcomes. */
export async function dispatchTick(
  p: DispatchParams,
): Promise<{ send_target: string; ok: boolean }[]> {
  const scenario = p.builder.name;
  const poolAddress = p.builder.poolAddress();

  // 1. Build (per target — instructions embed the payer) + sign every tx first.
  // Per-vantage nonce (same for all targets here — this worker is one vantage;
  // targets are distinguished by their own wallet). Distinguishes signatures
  // ACROSS vantages of the same challenge, which share a per-target wallet.
  const cuNonce = vantageCuNonce(p.vantage);
  const prepared = (await Promise.all(
    p.targets.map(async (dt) => {
      const built = await p.builder.build({ payer: dt.payer, direction: p.swapDirection });
      // null = skip this target this tick (e.g. reverse swap with a drained/zero
      // counter-token balance) — don't sign/send a ZeroTradableAmount revert.
      // Log it: a persistent skip means a target's reverse never funds (warmup
      // stuck / broken forward), which would otherwise vanish with no trace.
      if (!built) {
        console.warn(
          `[send/dispatch] skip ${p.builder.name}/${p.swapDirection} → ${dt.target.name}: build returned null (drained/zero reverse balance)`,
        );
        return null;
      }
      const tip = dt.target.tip;
      // The 7,500 nonce-advance overhead is NEVER added here — that's the
      // optional durable-nonce axis. cuNonce (≤4095) is folded into the limit
      // inside buildAndSignTx for signature uniqueness (zero extra compute).
      const baseCu = built.computeUnitLimit + (tip ? TIP_CU_OVERHEAD : 0);
      const { base64, signature } = await buildAndSignTx({
        payer: dt.payer,
        recentBlockhash: p.recentBlockhash,
        lastValidBlockHeight: p.lastValidBlockHeight,
        instructions: built.instructions,
        computeUnitLimit: baseCu,
        priorityFeeMicroLamports: p.priorityFeeMicroLamports,
        tip,
        cuNonce,
      });
      // Record the EFFECTIVE limit (base + nonce) so cu_requested is accurate.
      return { dt, base64, signature, tipAmount: BigInt(tip?.lamports ?? 0), cu: baseCu + cuNonce };
    }),
  )).filter((x): x is NonNullable<typeof x> => x !== null);

  // 2. Register all pending rows BEFORE any send.
  await Promise.all(
    prepared.map((x) =>
      p.db.execute(sql`
        INSERT INTO send_pending
          (signature, challenge_id, scenario, send_target, worker_provider, region, egress_path,
           sent_at, slot_sent, priority_fee, tip_amount, cu_requested, pool_address, swap_direction)
        VALUES
          (${x.signature}, ${p.challengeId}, ${scenario}, ${x.dt.target.name},
           ${p.vantage.worker_provider}, ${p.vantage.region}, ${p.vantage.egress_path},
           now(), ${p.sendSlot?.toString() ?? null}, ${p.priorityFeeMicroLamports}, ${x.tipAmount.toString()}, ${x.cu},
           ${poolAddress}, ${p.swapDirection})
        ON CONFLICT (signature) DO NOTHING
      `),
    ),
  );

  // 3. Barrier release: fire all sends at once.
  const results = await Promise.allSettled(
    prepared.map(async (x) => {
      const t0 = performance.now();
      await x.dt.target.send(x.base64);
      return { x, submitMs: Math.round(performance.now() - t0) };
    }),
  );

  // 4. Classify each: success → stamp submit latency; error → submit_error row.
  const outcomes: { send_target: string; ok: boolean }[] = [];
  await Promise.all(
    results.map(async (r, i) => {
      const x = prepared[i]!;
      if (r.status === "fulfilled") {
        await p.db.execute(sql`
          UPDATE send_pending SET submit_latency_ms = ${r.value.submitMs}
          WHERE signature = ${x.signature}
        `);
        outcomes.push({ send_target: x.dt.target.name, ok: true });
      } else {
        // Claim the pending row (single-winner), then write the submit_error row.
        const claimed = (await p.db.execute(sql`
          DELETE FROM send_pending WHERE signature = ${x.signature} RETURNING sent_at
        `)) as unknown as { sent_at: Date }[];
        if (claimed[0]) {
          await p.db.execute(sql`
            INSERT INTO landing_tx_results
              (challenge_id, scenario, send_target, worker_provider, region, egress_path,
               signature, outcome, landed, failed, submit_error, started_at, sent_at, slot_sent,
               priority_fee, tip_amount, cu_requested, pool_address, swap_direction, methodology_version)
            VALUES
              (${p.challengeId}, ${scenario}, ${x.dt.target.name},
               ${p.vantage.worker_provider}, ${p.vantage.region}, ${p.vantage.egress_path},
               ${x.signature}, 'submit_error', false, false, ${String(r.reason).slice(0, 500)},
               ${claimed[0].sent_at}, ${claimed[0].sent_at}, ${p.sendSlot?.toString() ?? null},
               ${p.priorityFeeMicroLamports}, ${x.tipAmount.toString()}, ${x.cu},
               ${poolAddress}, ${p.swapDirection}, ${SEND_METHODOLOGY_VERSION})
          `);
        }
        outcomes.push({ send_target: x.dt.target.name, ok: false });
      }
    }),
  );
  return outcomes;
}
