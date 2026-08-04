/**
 * Worker send-lane handler. Invoked from processOne when a claimed challenge has
 * archetype='send'. Loads the per-target wallets, builds the scenario, and fans
 * out to every configured send target via the barrier dispatcher.
 *
 * Gates on the confirm service's readiness — a send fired into a dead
 * subscription would be falsely reaped as not_landed, so we skip (don't
 * dispatch) until confirm reports subscribed + streaming.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";
import { SEND_TARGET_CONFIGS, type SendChallengeParams } from "@rpcbench/shared";
import { createSolanaRpc } from "@solana/kit";
import {
  DEFAULT_ORCA_CONFIG,
  DEFAULT_RAYDIUM_CONFIG,
  KeyRegistry,
  OrcaSwapBuilder,
  RaydiumSwapBuilder,
  TransferBuilder,
  createSendTarget,
  dispatchTick,
  kitPoolRpc,
  resolveTargetConfig,
  type DispatchTarget,
  type ScenarioBuilder,
  type SwapConfig,
} from "@rpcbench/send";

const CONFIRM_STALE_MS = 30_000;

export interface SendVantage {
  worker_provider: string;
  region: string;
  egress_path: string;
}

async function confirmReady(db: DbClient): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT ready, extract(epoch FROM now() - beat_at) * 1000 AS age_ms
    FROM send_service_status WHERE service = 'confirm'
  `)) as unknown as { ready: boolean; age_ms: number }[];
  const r = rows[0];
  return !!r && r.ready === true && Number(r.age_ms) < CONFIRM_STALE_MS;
}

/** RPC used to read pool state for swap builds (Raydium reverse balance, Orca
 *  whirlpool tick arrays) + the send-time getSlot. A neutral endpoint — NOT one
 *  of the send targets. Resolved at CALL time: a module-level const would read
 *  process.env at import, before the worker's loadEnv() runs (→ undefined). */
function poolRpcUrl(): string | undefined {
  return process.env.SEND_POOL_RPC_URL ?? process.env.UTILITY_RPC_URL ?? process.env.HELIUS_URL;
}

/** Build the scenario builder for a challenge. Swaps use the built-in benchmark
 *  pool configs (defaultPools.ts), overridable via SEND_RAYDIUM_CONFIG /
 *  SEND_ORCA_CONFIG for a custom pool. */
function builderFor(scenario: string): ScenarioBuilder | null {
  if (scenario === "transfer") return new TransferBuilder();
  const url = poolRpcUrl();
  if (!url) {
    console.warn("[worker/send] no SEND_POOL_RPC_URL/UTILITY_RPC_URL/HELIUS_URL for pool reads; skipping swap");
    return null;
  }
  const rpc = kitPoolRpc(createSolanaRpc(url));
  if (scenario === "raydium_swap") {
    const cfg = process.env.SEND_RAYDIUM_CONFIG
      ? (JSON.parse(process.env.SEND_RAYDIUM_CONFIG) as SwapConfig & { poolAddress: string })
      : DEFAULT_RAYDIUM_CONFIG;
    return new RaydiumSwapBuilder(cfg, cfg.poolAddress, rpc);
  }
  if (scenario === "orca_swap") {
    // Orca resolves accounts dynamically — config is just pool + mints + amount.
    const cfg = process.env.SEND_ORCA_CONFIG
      ? (JSON.parse(process.env.SEND_ORCA_CONFIG) as {
          poolAddress: string;
          tokenAMint: string;
          tokenBMint: string;
          swapAmountLamports: number;
        })
      : DEFAULT_ORCA_CONFIG;
    return new OrcaSwapBuilder(cfg.poolAddress, cfg.tokenAMint, cfg.tokenBMint, cfg.swapAmountLamports, rpc);
  }
  return null;
}

export interface HandleSendParams {
  db: DbClient;
  challengeId: string;
  params: SendChallengeParams;
  vantage: SendVantage;
}

/** Execute a claimed send challenge. */
export async function handleSendChallenge(p: HandleSendParams): Promise<void> {
  if (!(await confirmReady(p.db))) {
    console.warn("[worker/send] confirm not ready; skipping send tick");
    return;
  }
  const builder = builderFor(p.params.scenario);
  if (!builder) {
    console.warn(`[worker/send] scenario ${p.params.scenario} not configured; skipping`);
    return;
  }

  const registry = new KeyRegistry(p.db);
  const targets: DispatchTarget[] = [];
  for (const cfg of SEND_TARGET_CONFIGS) {
    const resolved = resolveTargetConfig(cfg, p.vantage.region);
    if (!resolved) continue; // target not configured on this deployment
    const payer = await registry.loadOrCreate(`${cfg.name}:${p.params.scenario}`, "payer", {
      scenario: p.params.scenario,
      sendTarget: cfg.name,
    });
    targets.push({ target: createSendTarget(resolved), payer });
  }
  if (targets.length === 0) {
    console.warn("[worker/send] no configured send targets for region", p.vantage.region);
    return;
  }

  // Stamp the head slot at SEND time (one getSlot for the whole barrier-fired
  // dispatch → same baseline for all targets). This is slot_latency's zero-point;
  // the confirm poll must NOT re-derive it (its ~2s poll lags the actual send).
  let sendSlot: bigint | null = null;
  const slotUrl = poolRpcUrl();
  if (slotUrl) {
    try {
      sendSlot = BigInt(await createSolanaRpc(slotUrl).getSlot({ commitment: "confirmed" }).send());
    } catch (e) {
      console.warn("[worker/send] getSlot for slot_sent failed:", (e as Error).message);
    }
  }

  await dispatchTick({
    db: p.db,
    challengeId: p.challengeId,
    builder,
    swapDirection: p.params.swap_direction ?? "forward",
    vantage: p.vantage,
    recentBlockhash: p.params.recent_blockhash,
    lastValidBlockHeight: BigInt(p.params.last_valid_block_height),
    sendSlot,
    priorityFeeMicroLamports: p.params.priority_fee,
    targets,
  });
}
