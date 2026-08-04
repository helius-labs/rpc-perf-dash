/**
 * Send confirmation — folded into the generator (was the standalone apps/confirm).
 *
 * The generator is already a leader-elected singleton running periodic jobs, so
 * the confirm poll rides alongside them: every ~2s it reads the in-flight
 * `send_pending` rows and polls `getSignatureStatuses` (via the generator's
 * `utility` RPC), classifying confirmed txs (landed / reverted) with a
 * single-winner `DELETE … RETURNING` and reaping rows older than ~80s as
 * not_landed. No Yellowstone/gRPC; block position isn't derivable from status
 * polling and isn't scored.
 *
 * `slot_sent` is the WORKER's head slot at send time (stored on the send_pending
 * row), NOT stamped here — a poll-time stamp lags the actual send by up to a poll
 * interval and would exceed slot_landed for fast lands. slot_landed comes from the
 * status; slot_latency = slot_landed − slot_sent is thus poll-cadence-independent.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";
import { SEND_METHODOLOGY_VERSION, type RpcClient } from "@rpcbench/shared";

/** ~80s reaper: a recent-blockhash tx can't land past blockhash expiry. */
export const REAP_TIMEOUT_MS = 80_000;
/** getSignatureStatuses accepts at most 256 signatures per call. */
const STATUS_BATCH = 256;

interface PendingRow {
  signature: string;
  challenge_id: string;
  scenario: string;
  send_target: string;
  worker_provider: string;
  region: string;
  egress_path: string;
  sent_at: string;
  slot_sent: string | null;
  submit_latency_ms: number | null;
  priority_fee: string;
  tip_amount: string;
  cu_requested: number;
  pool_address: string | null;
  swap_direction: string | null;
}

interface SigStatus {
  slot: number;
  err: unknown | null;
  confirmationStatus: string | null;
}

async function fetchPending(db: DbClient): Promise<PendingRow[]> {
  return (await db.execute(sql`
    SELECT signature, challenge_id, scenario, send_target, worker_provider, region,
           egress_path, sent_at, slot_sent, submit_latency_ms, priority_fee, tip_amount,
           cu_requested, pool_address, swap_direction
    FROM send_pending
  `)) as unknown as PendingRow[];
}

/** Single-winner claim → INSERT a landed/reverted final row. cu_used isn't
 *  available from status polling, so it's null. */
async function classifyLanded(
  db: DbClient,
  row: PendingRow,
  slotLanded: bigint,
  reverted: boolean,
): Promise<void> {
  const claimed = (await db.execute(sql`
    DELETE FROM send_pending WHERE signature = ${row.signature}
    RETURNING sent_at, submit_latency_ms
  `)) as unknown as { sent_at: string; submit_latency_ms: number | null }[];
  if (!claimed[0]) return; // reaper (or a peer) already took it

  const slotLatency = row.slot_sent !== null ? (slotLanded - BigInt(row.slot_sent)).toString() : null;
  const wallLatency = Math.round(Date.now() - new Date(row.sent_at).getTime());

  await db.execute(sql`
    INSERT INTO landing_tx_results
      (challenge_id, scenario, send_target, worker_provider, region, egress_path,
       signature, outcome, landed, failed, started_at, sent_at, submit_latency_ms,
       slot_sent, slot_landed, slot_latency, wall_latency_ms,
       priority_fee, tip_amount, cu_requested, cu_used, pool_address, swap_direction,
       methodology_version)
    VALUES
      (${row.challenge_id}, ${row.scenario}, ${row.send_target},
       ${row.worker_provider}, ${row.region}, ${row.egress_path},
       ${row.signature}, ${reverted ? "reverted" : "landed"}, true, ${reverted},
       ${row.sent_at}, ${row.sent_at}, ${claimed[0].submit_latency_ms ?? null},
       ${row.slot_sent}, ${slotLanded.toString()}, ${slotLatency}, ${wallLatency},
       ${row.priority_fee}, ${row.tip_amount}, ${row.cu_requested}, ${null}, ${row.pool_address},
       ${row.swap_direction}, ${SEND_METHODOLOGY_VERSION})
  `);
}

/** Reaper: claim a stale pending row → INSERT a not_landed final row. */
async function reapOne(db: DbClient, row: PendingRow): Promise<void> {
  const claimed = (await db.execute(sql`
    DELETE FROM send_pending WHERE signature = ${row.signature}
    RETURNING sent_at, submit_latency_ms
  `)) as unknown as { sent_at: string; submit_latency_ms: number | null }[];
  if (!claimed[0]) return; // confirm already classified it

  await db.execute(sql`
    INSERT INTO landing_tx_results
      (challenge_id, scenario, send_target, worker_provider, region, egress_path,
       signature, outcome, landed, failed, started_at, sent_at, submit_latency_ms,
       slot_sent, priority_fee, tip_amount, cu_requested, pool_address, swap_direction,
       methodology_version)
    VALUES
      (${row.challenge_id}, ${row.scenario}, ${row.send_target},
       ${row.worker_provider}, ${row.region}, ${row.egress_path},
       ${row.signature}, 'not_landed', false, false,
       ${row.sent_at}, ${row.sent_at}, ${claimed[0].submit_latency_ms ?? null},
       ${row.slot_sent}, ${row.priority_fee}, ${row.tip_amount},
       ${row.cu_requested}, ${row.pool_address}, ${row.swap_direction},
       ${SEND_METHODOLOGY_VERSION})
  `);
}

/** Heartbeat the readiness the worker send lane gates on. */
export async function heartbeatConfirm(db: DbClient, ready: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO send_service_status (service, ready, beat_at)
    VALUES ('confirm', ${ready}, now())
    ON CONFLICT (service) DO UPDATE SET ready = ${ready}, beat_at = now()
  `);
}

/**
 * One confirm poll cycle: poll statuses for in-flight sends, classify confirmed
 * ones, reap stale ones. Heartbeats ready=true on success so the worker gate
 * stays fresh even with zero in-flight sends.
 */
export async function runConfirmPoll(db: DbClient, utility: RpcClient): Promise<void> {
  const pending = await fetchPending(db);

  if (pending.length > 0) {
    // Classify confirmed txs (in status batches).
    for (let i = 0; i < pending.length; i += STATUS_BATCH) {
      const batch = pending.slice(i, i + STATUS_BATCH);
      const res = await utility.call<{ value: (SigStatus | null)[] }>("getSignatureStatuses", [
        batch.map((r) => r.signature),
        { searchTransactionHistory: false },
      ]);
      for (let j = 0; j < batch.length; j++) {
        const st = res.value[j];
        const row = batch[j]!;
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          await classifyLanded(db, row, BigInt(st.slot), st.err != null);
        }
      }
    }
    // Reap stale rows that never confirmed (single-winner DELETE skips any the
    // classify pass just took).
    const now = Date.now();
    for (const row of pending) {
      if (now - new Date(row.sent_at).getTime() > REAP_TIMEOUT_MS) {
        await reapOne(db, row);
      }
    }
  }

  await heartbeatConfirm(db, true);
}
