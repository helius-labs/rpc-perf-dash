import { sql } from "drizzle-orm";
import { type DbClient, firstRow } from "@rpcbench/db";

export interface ClaimedAssignment {
  challenge_id: string;
  method: string;
  params: unknown;
  bucket: string;
  reference_hash: Buffer;
  reference_response: unknown;
  reference_tip_slot: bigint;
  is_honeypot: boolean;
  expires_at: Date;
}

/**
 * Claim the next ready challenge for this (worker_provider, region, egress_path).
 * Uses FOR UPDATE SKIP LOCKED so concurrent workers can pull different rows.
 *
 * Note: workers query the joined challenge but DO NOT read `is_honeypot` from
 * challenges directly — they go through `challenges_worker_view`.
 */
export async function claimNext(
  db: DbClient,
  workerProvider: string,
  region: string,
  egressPath: string,
  workerId: string,
): Promise<ClaimedAssignment | null> {
  const r = await firstRow<{ challenge_id: string }>(
    db,
    sql`
    WITH claimed AS (
      SELECT challenge_id
      FROM challenge_assignments
      WHERE worker_provider = ${workerProvider}
        AND region = ${region}
        AND egress_path = ${egressPath}
        AND status = 'unclaimed'
      ORDER BY challenge_id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE challenge_assignments a
    SET status = 'claimed', claimed_at = now(), worker_id = ${workerId}
    FROM claimed
    WHERE a.challenge_id = claimed.challenge_id
      AND a.worker_provider = ${workerProvider}
      AND a.region = ${region}
      AND a.egress_path = ${egressPath}
    RETURNING a.challenge_id
  `,
  );
  if (!r) return null;

  const raw = await firstRow<{
    challenge_id: string;
    method: string;
    params: unknown;
    bucket: string;
    expires_at: string | Date;
    reference_hash: Buffer | Uint8Array | null;
    reference_response: unknown;
    reference_tip_slot: string | number | bigint | null;
    is_honeypot: boolean;
  }>(
    db,
    sql`
    SELECT
      c.id AS challenge_id,
      v.method, v.params, v.bucket, v.expires_at,
      c.reference_hash, c.reference_response, c.reference_tip_slot, c.is_honeypot
    FROM challenges c
    JOIN challenges_worker_view v ON v.id = c.id
    WHERE c.id = ${r.challenge_id}
  `,
  );
  if (!raw) return null;

  return {
    challenge_id: raw.challenge_id,
    method: raw.method,
    params: raw.params,
    bucket: raw.bucket,
    expires_at: raw.expires_at instanceof Date ? raw.expires_at : new Date(raw.expires_at),
    reference_hash: Buffer.isBuffer(raw.reference_hash)
      ? raw.reference_hash
      : raw.reference_hash
        ? Buffer.from(raw.reference_hash)
        : Buffer.alloc(0),
    reference_response: raw.reference_response,
    reference_tip_slot:
      raw.reference_tip_slot == null
        ? 0n
        : typeof raw.reference_tip_slot === "bigint"
          ? raw.reference_tip_slot
          : BigInt(raw.reference_tip_slot),
    is_honeypot: raw.is_honeypot,
  };
}

export async function markDone(
  db: DbClient,
  challengeId: string,
  workerProvider: string,
  region: string,
  egressPath: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE challenge_assignments
    SET status = 'done', completed_at = now()
    WHERE challenge_id = ${challengeId}
      AND worker_provider = ${workerProvider}
      AND region = ${region}
      AND egress_path = ${egressPath}
  `);
}
