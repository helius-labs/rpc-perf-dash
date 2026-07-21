/**
 * Narrow interface for `samples` access.
 *
 * Storage portability: keep this file Postgres-flavored only at the implementation
 * level. Hot-path callers (workers, generator) interact with the function
 * signatures, not the SQL. Swapping to ClickHouse later means re-implementing
 * this file, not changing call sites.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "./index.js";
import { samples, challenges } from "./schema.js";

// Hard ceilings on the sample write path. A sample INSERT that wedges on the
// storage layer (e.g. a partition-boundary stall) MUST error and let the worker
// retry — never hang for hours holding a lock, which is how a single stuck
// insert convoyed the whole `samples` table and took the fleet down for ~18h.
// SET LOCAL (not session SET) because workers use the transaction pooler, where
// session-level SETs don't persist across checkouts.
const INSERT_STATEMENT_TIMEOUT = "15s";
const INSERT_LOCK_TIMEOUT = "5s";

export interface SampleRow {
  challenge_id: string;
  method: string;
  provider_id: string;
  worker_provider: string;
  region: string;
  worker_id: string;
  egress_path: string;
  endpoint_used: string;
  bucket: string;
  connection_mode: "cold" | "warm";
  started_at: Date;
  latency_ms: number;
  status: "ok" | "error" | "timeout";
  error_code: string | null;
  http_status: number | null;
  response_hash: Buffer;
  provider_tip_slot: bigint | null;
  reference_tip_slot: bigint | null;
  response_slot: bigint | null;
  freshness_lag: bigint | null;
  correctness: string;
  exclusion_reason: string | null;
  failure_category: string | null;
  failure_detail: string | null;
  methodology_version: number;
  is_honeypot: boolean;
  raw_response: unknown | null;
}

/**
 * Bulk-insert samples. Workers call this with up to ~1000 rows per batch.
 * Idempotent on (challenge_id, provider_id, region, connection_mode) via upsert
 * if needed — but in practice each (challenge × provider × region × mode) is
 * written exactly once per benchmark cycle.
 */
export async function insertSamples(db: DbClient, rows: SampleRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Drizzle doesn't model `bytea` as Buffer cleanly across versions; pass-through.
  // Bound the write with per-transaction timeouts so a storage-layer stall
  // surfaces as a retryable error instead of an indefinite wedge.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${INSERT_STATEMENT_TIMEOUT}'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${INSERT_LOCK_TIMEOUT}'`));
    await tx.insert(samples).values(rows as never);
  });

  // Flag the challenge(s) as having samples so the generator's stale-expiry job
  // can skip them via the `has_samples` flag instead of a NOT EXISTS scan over
  // `samples`. Best-effort: the sample insert above is authoritative, so a flag
  // failure must never fail the write path (the worst case is a sampled
  // challenge briefly looking empty until a retry/backfill flags it). The guard
  // on `has_samples = false` keeps this to a single write per challenge.
  try {
    const ids = [...new Set(rows.map((r) => r.challenge_id))];
    await db
      .update(challenges)
      .set({ has_samples: true })
      .where(and(inArray(challenges.id, ids), eq(challenges.has_samples, false)));
  } catch (err) {
    console.error("[insertSamples] has_samples flag update failed (non-fatal)", err);
  }
}
