/**
 * One-off backfill for migration 0020 (challenges.has_samples).
 *
 * Run AFTER migration 0020 and AFTER the workers are deployed (so new samples
 * already set the flag), but BEFORE re-enabling the rewritten expireStaleChallenges
 * on the generator — otherwise sampled-but-unflagged challenges would be
 * mislabeled `expired`:
 *   pnpm --filter generator exec tsx src/backfill-has-samples.ts
 *
 * Sets has_samples=true for every challenge that has ≥1 sample, processed one
 * DAY at a time. Each iteration's `started_at` range prunes to a single daily
 * `samples` partition, so it's a bounded sequential pass (no per-challenge
 * NOT EXISTS probe explosion, no all-partitions seq scan) — gentle on Neon.
 *
 * Idempotent: only flips has_samples=false→true; safe to re-run.
 */

import { sql } from "drizzle-orm";
import { createDb } from "@rpcbench/db";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

// samples retains ~30 days; go back a touch further for safety.
const DAYS_BACK = 32;

async function main() {
  const db = createDb({ mode: "direct" });
  for (let daysAgo = DAYS_BACK; daysAgo >= 0; daysAgo--) {
    const res = await db.execute(sql`
      UPDATE challenges c
      SET has_samples = true
      FROM (
        SELECT DISTINCT challenge_id
        FROM samples
        WHERE started_at >= date_trunc('day', now()) - make_interval(days => ${daysAgo})
          AND started_at <  date_trunc('day', now()) - make_interval(days => ${daysAgo - 1})
      ) s
      WHERE c.id = s.challenge_id AND c.has_samples = false
    `);
    console.log(`[has_samples-backfill] day -${daysAgo}: flagged ${res.count ?? 0}`);
  }
  console.log("[has_samples-backfill] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[has_samples-backfill] fatal", err);
  process.exit(1);
});
