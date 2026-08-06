/**
 * Send challenge tick (port of `orchestrator.rs::run_tick`, generator side).
 *
 * Emits ONE send challenge per (scenario × tick) — reusing the read pipeline via
 * sentinels (method='send:<scenario>', synthetic commitment, placeholder
 * reference) with archetype='send'. The WORKER does the per-target fan-out
 * (it loads per-target wallets + dispatches). No commit-reveal, no seed.
 *
 * All targets in a tick share the same blockhash value + payload + priority fee
 * (fairness); each worker signs from its own per-target wallet (independence).
 *
 * The priority fee is ADAPTIVE — a proportional controller nudges it toward an
 * aggregate landing band of ~50–70% (the regime where send paths separate),
 * read from the last send_rollups_5m window. The in-effect fee is stamped on
 * every row for cross-time normalization.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbClient, Vantage } from "@rpcbench/db";
import { createReadyChallenge } from "@rpcbench/db";
import { canonicalize } from "@rpcbench/shared/canonical";
import type { RpcClient, Scenario, SwapDirection, SendChallengeParams } from "@rpcbench/shared";
import { SEND_METHODOLOGY_VERSION } from "@rpcbench/shared";
import { SCENARIO_CU_LIMIT } from "@rpcbench/send";

const SEND_CHALLENGE_TTL_S = 30;
const FEE_MIN = 1_000;
const FEE_MAX = 2_000_000;
const FEE_INIT = 20_000;
const LANDING_BAND = { lo: 0.5, hi: 0.7 };

/** Per-scenario controller state (single-leader generator → module state is fine). */
const feeState = new Map<Scenario, number>();
const directionState = new Map<Scenario, SwapDirection>();

/** Read the most recent aggregate landing rate for a scenario (0..1) or null. */
async function recentLandingRate(db: DbClient, scenario: Scenario): Promise<number | null> {
  const rows = (await db.execute(sql`
    SELECT sum(landed_count + reverted_count)::float / NULLIF(sum(sample_count_total), 0) AS rate
    FROM send_rollups_5m
    WHERE scenario = ${scenario} AND window_start >= now() - interval '15 minutes'
  `)) as unknown as { rate: number | null }[];
  return rows[0]?.rate ?? null;
}

/** Proportional fee controller: nudge toward the ~50–70% landing band. */
async function nextFee(db: DbClient, scenario: Scenario): Promise<number> {
  const cur = feeState.get(scenario) ?? FEE_INIT;
  const rate = await recentLandingRate(db, scenario);
  let next = cur;
  if (rate !== null) {
    if (rate > LANDING_BAND.hi) next = Math.round(cur * 0.8); // landing too easy → lower fee
    else if (rate < LANDING_BAND.lo) next = Math.round(cur * 1.25); // too hard → raise fee
  }
  next = Math.max(FEE_MIN, Math.min(FEE_MAX, next));
  feeState.set(scenario, next);
  return next;
}

/** Flip swap direction each tick to conserve token inventory. */
function nextDirection(scenario: Scenario): SwapDirection {
  const cur = directionState.get(scenario) ?? "reverse";
  const next: SwapDirection = cur === "forward" ? "reverse" : "forward";
  directionState.set(scenario, next);
  return next;
}

export interface SendTickDeps {
  db: DbClient;
  utility: RpcClient;
  /** Sampled vantages for this challenge (the caller applies K-sampling). */
  sampleVantages: () => Vantage[];
  /** Scenarios enabled this deployment. */
  scenarios: readonly Scenario[];
}

/** Emit one send challenge per enabled scenario. */
export async function runSendTick(deps: SendTickDeps): Promise<void> {
  const { value: bh } = await deps.utility.call<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const slot = await deps.utility.call<number>("getSlot", [{ commitment: "confirmed" }]);

  for (const scenario of deps.scenarios) {
    const priorityFee = await nextFee(deps.db, scenario);
    const isSwap = scenario !== "transfer";
    const params: SendChallengeParams = {
      scenario,
      recent_blockhash: bh.blockhash,
      last_valid_block_height: bh.lastValidBlockHeight,
      compute_unit_limit: SCENARIO_CU_LIMIT[scenario],
      priority_fee: priorityFee,
      swap_direction: isSwap ? nextDirection(scenario) : undefined,
      nonce_race_id: null,
    };
    const commitment = createHash("sha256").update(canonicalize(params)).digest();

    const vantages = deps.sampleVantages();
    if (vantages.length === 0) continue;

    await createReadyChallenge(
      deps.db,
      {
        method: `send:${scenario}`,
        params,
        bucket: scenario,
        commitment_hash: commitment,
        ttl_seconds: SEND_CHALLENGE_TTL_S,
        methodology_version: SEND_METHODOLOGY_VERSION,
        is_honeypot: false,
        archetype: "send",
      },
      // Placeholder reference — sends have no consensus reference; carry the
      // generator slot only (diagnostic; NOT the send baseline — confirm assigns
      // slot_sent on its own clock).
      { response: null, hash: Buffer.alloc(32), tip_slot: BigInt(slot) },
      vantages,
    );
  }
}
