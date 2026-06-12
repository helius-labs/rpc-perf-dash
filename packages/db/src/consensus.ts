/**
 * Narrow interface for consensus + auditor persistence. Called by the worker
 * (`packages/runner/src/record.ts`) and the finality re-verification job
 * (`apps/generator/src/rollup.ts`).
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "./index.js";
import { consensus_audit, consensus_log } from "./schema.js";

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
  auditor_verdict: "verified" | "disputed" | "auditor_unavailable";
}

/**
 * Idempotent UPSERT on the natural key. Called from `buildSampleRows` for the
 * subset of (challenge, vantage, mode) groups we keep an audit trail for
 * (disputed + archive sample + honeypots).
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
      auditor_verdict: row.auditor_verdict,
    } as never)
    .onConflictDoNothing();
}

export interface ConsensusAuditRow {
  challenge_id: string;
  method: string;
  consensus_hash: Buffer;
  canonical_hash: Buffer | null;
  matched: boolean | null;
  error: string | null;
}

/** Idempotent UPSERT — one audit row per challenge. */
export async function insertConsensusAudit(
  db: DbClient,
  row: ConsensusAuditRow,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO consensus_audit (
      challenge_id, method, audited_at,
      consensus_hash, canonical_hash, matched, error
    ) VALUES (
      ${row.challenge_id}::uuid, ${row.method}, now(),
      ${row.consensus_hash as never}::bytea,
      ${row.canonical_hash as never}::bytea,
      ${row.matched}, ${row.error}
    )
    ON CONFLICT (challenge_id) DO UPDATE SET
      audited_at     = now(),
      canonical_hash = EXCLUDED.canonical_hash,
      matched        = EXCLUDED.matched,
      error          = EXCLUDED.error
  `);
  // Silence unused — the prepared values above use the row directly.
  void consensus_audit;
}
