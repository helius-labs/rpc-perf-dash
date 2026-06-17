/**
 * Storage-bounding maintenance, folded into the generator process.
 *
 * Two jobs, both batched and idempotent, run on their own interval (never
 * chained onto the rollup tick — the leaderboard CTE there can exceed the
 * interval and would starve tail work; see docs/operations.md and the
 * runFinalityRecheck precedent):
 *
 *   1. trimReferenceResponses — nulls challenges.reference_response once a
 *      challenge is >6h old. That JSON (full getBlock/getTransaction payloads)
 *      dominates DB size and is dead weight after the ~30s active window:
 *      scoring + runFinalityRecheck use the small reference_hash, and only /raw
 *      renders the payload (guarded to show "trimmed" past 6h). The row and
 *      reference_hash are kept forever.
 *
 *   2. pruneControlTables — caps the unbounded control-plane tables at 31 days
 *      (one day past the dashboard's 720h max window). Deleting a challenge
 *      cascades (ON DELETE CASCADE) to challenge_assignments, consensus_log,
 *      consensus_audit, and quorum_log. `samples` is NOT a FK child (it keeps
 *      its own 30d partition retention), so it is untouched here.
 *
 * Both loop a `ctid IN (SELECT ctid ... LIMIT n)` batch until a batch comes
 * back empty — Postgres DELETE/UPDATE don't take a LIMIT directly, and the ctid
 * form keeps each statement's transaction small. The trim query is backed by
 * the partial index challenges_ref_pending_idx (migration 0022); without it the
 * inner SELECT would seq-scan the whole >6h slice every tick.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";

const REFERENCE_TTL = "6 hours";
const CONTROL_RETENTION = "31 days";

const TRIM_BATCH = 5_000;
const DELETE_BATCH = 10_000;

// Safety cap on batches per invocation so a large one-time backlog doesn't pin
// a single tick indefinitely — it simply resumes on the next interval. At
// TRIM_BATCH=5k this is up to 1M rows/tick.
const MAX_BATCHES_PER_RUN = 200;

/** Number of rows returned by a `... RETURNING 1` statement. */
function affected(res: unknown): number {
  return (res as unknown[]).length;
}

/**
 * Null reference_response for challenges past REFERENCE_TTL, in batches.
 * Returns the total rows nulled this run.
 */
export async function trimReferenceResponses(db: DbClient): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    // `ORDER BY generated_at` is load-bearing, not cosmetic. Non-null payloads
    // are almost all <6h old (we trim the rest), so the planner badly
    // overestimates how many rows match `reference_response IS NOT NULL AND
    // generated_at < 6h` (assumes independence; treats it as ~110k when it's
    // really hundreds). Under that estimate + LIMIT it picks a full seq scan of
    // challenges (~1.3GB) every tick. The ORDER BY lets it use
    // challenges_ref_pending_idx for the ordering, which bounds the scan to the
    // few genuinely-old rows. (Plain ANALYZE does NOT fix this — it's a
    // cross-predicate correlation, not stale single-column stats.)
    const res = await db.execute(sql`
      UPDATE challenges SET reference_response = NULL
      WHERE ctid IN (
        SELECT ctid FROM challenges
        WHERE reference_response IS NOT NULL
          AND generated_at < now() - ${sql.raw(`interval '${REFERENCE_TTL}'`)}
        ORDER BY generated_at
        LIMIT ${TRIM_BATCH}
      )
      RETURNING 1
    `);
    const n = affected(res);
    total += n;
    if (n < TRIM_BATCH) break;
  }
  return total;
}

/**
 * Delete challenges older than CONTROL_RETENTION (cascades to assignments and
 * consensus/quorum logs), then prune accumulated eligibility snapshots by their
 * window_end. Returns total rows deleted from `challenges` this run.
 */
export async function pruneControlTables(db: DbClient): Promise<number> {
  let challengesDeleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const res = await db.execute(sql`
      DELETE FROM challenges
      WHERE ctid IN (
        SELECT ctid FROM challenges
        WHERE generated_at < now() - ${sql.raw(`interval '${CONTROL_RETENTION}'`)}
        LIMIT ${DELETE_BATCH}
      )
      RETURNING 1
    `);
    const n = affected(res);
    challengesDeleted += n;
    if (n < DELETE_BATCH) break;
  }

  // eligibility accumulates a fresh row-set per heavy-rollup tick (~288/day)
  // keyed on window_end; it is write-only (the dashboard derives gates inline
  // via eligibilityFloors, never SELECTing it), so anything past the retention
  // window is safe to drop.
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const res = await db.execute(sql`
      DELETE FROM eligibility
      WHERE ctid IN (
        SELECT ctid FROM eligibility
        WHERE window_end < now() - ${sql.raw(`interval '${CONTROL_RETENTION}'`)}
        LIMIT ${DELETE_BATCH}
      )
      RETURNING 1
    `);
    if (affected(res) < DELETE_BATCH) break;
  }

  return challengesDeleted;
}

/** Run both maintenance jobs once. Trim first (frees the most bytes). */
export async function runMaintenance(db: DbClient): Promise<void> {
  const trimmed = await trimReferenceResponses(db);
  if (trimmed > 0) console.log(`[maintenance] nulled reference_response on ${trimmed} challenge(s)`);
  const deleted = await pruneControlTables(db);
  if (deleted > 0) console.log(`[maintenance] deleted ${deleted} challenge(s) past ${CONTROL_RETENTION}`);
}
