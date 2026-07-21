/**
 * Narrow interface for consensus persistence. Called by the worker
 * (`packages/runner/src/record.ts`).
 */

import { consensus_log } from "./schema.js";
import type { DbClient } from "./index.js";

export interface ConsensusLogRow {
  challenge_id: string;
  worker_provider: string;
  region: string;
  egress_path: string;
  connection_mode: "cold" | "warm";
  voters: unknown;
  decision: "consensus" | "ambiguous" | "liveness_fallback";
  decision_reason: string | null;
  dissenters: readonly string[];
}

/**
 * Idempotent UPSERT on the natural key. Persists the consensus-log rows that
 * `buildSampleRows` (runner) emits for the subset of (challenge, vantage,
 * mode) groups we keep an audit trail for (archive sample + honeypots).
 */
export async function insertConsensusLog(
  db: DbClient,
  row: ConsensusLogRow,
): Promise<void> {
  await db
    .insert(consensus_log)
    .values({
      challenge_id: row.challenge_id,
      worker_provider: row.worker_provider,
      region: row.region,
      egress_path: row.egress_path,
      connection_mode: row.connection_mode,
      voters: row.voters as never,
      decision: row.decision,
      decision_reason: row.decision_reason,
      dissenters: row.dissenters as never,
    } as never)
    .onConflictDoNothing();
}
