/**
 * Narrow interface for control-plane access (challenges, assignments, heartbeats).
 *
 * Workers only ever read from `challenges_worker_view` — they never see is_honeypot.
 *
 * A challenge has no "pending_quorum" phase: the generator captures the
 * auditor (utility) reference and writes the challenge + assignments in one
 * step. Correctness is decided per-sample in the worker via majority consensus
 * across the benchmarked panel.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "./index.js";
import { challenge_assignments, challenges } from "./schema.js";

export interface NewChallenge {
  method: string;
  params: unknown;
  bucket: string;
  commitment_hash: Buffer;
  /**
   * Challenge time-to-live in seconds. `expires_at` is derived from the
   * DATABASE clock (`now() + ttl`) inside createReadyChallenge — NOT from the
   * generator process's wall clock — so a clock-skewed generator container can
   * never stamp a challenge `expires_at` in the past (which would make workers
   * skip it via the expired-on-claim path and silently produce zero samples).
   */
  ttl_seconds: number;
  methodology_version: number;
  is_honeypot: boolean;
  /** Optional benchmark-run UUID. Set by the one-shot CLI; null for continuous mode. */
  run_id?: string | null;
}

export interface Vantage {
  worker_provider: string;
  region: string;
  egress_path: string;
}

export interface Reference {
  response: unknown;
  hash: Buffer;
  tip_slot: bigint;
}

/**
 * Create a `ready` challenge with the auditor reference attached and fan out
 * one assignment row per active vantage. Replaces the prior two-phase flow
 * (insertPendingChallenge → runQuorum → markChallengeReady).
 *
 * For honeypots, `reference` is the pre-seeded known answer rather than an
 * auditor fetch (the worker's record.ts short-circuits the consensus path on
 * is_honeypot and classifies directly against this reference).
 */
export async function createReadyChallenge(
  db: DbClient,
  c: NewChallenge,
  reference: Reference,
  vantages: readonly Vantage[],
): Promise<string> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(challenges)
      .values({
        method: c.method,
        params: c.params,
        bucket: c.bucket,
        commitment_hash: c.commitment_hash,
        // Both timestamps come from the DB clock so they can never disagree.
        // generated_at would default to now() anyway; we set it explicitly to
        // make the "same clock as expires_at" invariant obvious at the call site.
        generated_at: sql`now()`,
        expires_at: sql`now() + make_interval(secs => ${c.ttl_seconds})`,
        methodology_version: c.methodology_version,
        status: "ready",
        is_honeypot: c.is_honeypot,
        run_id: c.run_id ?? null,
        reference_response: reference.response,
        reference_hash: reference.hash,
        reference_tip_slot: reference.tip_slot,
      })
      .returning({ id: challenges.id });
    if (!row) throw new Error("createReadyChallenge: no id returned");

    if (vantages.length > 0) {
      const assignments = vantages.map((v) => ({
        challenge_id: row.id,
        worker_provider: v.worker_provider,
        region: v.region,
        egress_path: v.egress_path,
        status: "unclaimed",
      }));
      await tx.insert(challenge_assignments).values(assignments as never);
    }
    return row.id;
  });
}

/**
 * Stash the revealed seed on a ready challenge. Honeypots reveal immediately;
 * normal challenges store the seed and the reveal-cron flips
 * `seed_revealed_at` once `expires_at < now()`.
 */
export async function stashSeed(
  db: DbClient,
  challengeId: string,
  seed: Buffer,
  reveal: "immediate" | "after_expiry",
): Promise<void> {
  if (reveal === "immediate") {
    await db.execute(sql`
      UPDATE challenges
      SET seed = ${seed as never}, seed_revealed_at = now()
      WHERE id = ${challengeId}::uuid
    `);
  } else {
    await db.execute(sql`
      UPDATE challenges
      SET seed = ${seed as never}
      WHERE id = ${challengeId}::uuid
    `);
  }
}
