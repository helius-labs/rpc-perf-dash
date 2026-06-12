/**
 * Narrow interface for `samples` access.
 *
 * Storage portability: keep this file Postgres-flavored only at the implementation
 * level. Hot-path callers (workers, generator) interact with the function
 * signatures, not the SQL. Swapping to ClickHouse later means re-implementing
 * this file (and rollups.ts), not changing call sites.
 */

import type { DbClient } from "./index.js";
import { samples } from "./schema.js";

export interface SampleRow {
  challenge_id: string;
  method: string;
  provider_id: string;
  plan_tier: string | null;
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
  ranking_eligible: boolean;
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
  await db.insert(samples).values(rows as never);
}

/**
 * Lookup samples by challenge id. Used by `/raw?challenge=...`.
 */
export async function samplesForChallenge(
  db: DbClient,
  challengeId: string,
): Promise<SampleRow[]> {
  const rows = await db.query.samples.findMany({
    where: (s, { eq }) => eq(s.challenge_id, challengeId),
  });
  return rows as unknown as SampleRow[];
}
