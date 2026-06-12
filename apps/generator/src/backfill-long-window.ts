/**
 * One-off backfill for the long-window-perf change (migration 0010).
 *
 * Run AFTER applying migration 0010, ONCE, against the target DB:
 *   pnpm --filter generator exec tsx src/backfill-long-window.ts
 *
 * Why it's needed: the rollup tick only recomputes a trailing 2h/2d each run,
 * so on a fresh deploy `rollups_1h`/`rollups_1d` (chart history) and the new
 * `leaderboard_agg_*` / `leaderboard_challenges_*` tables only cover the last
 * couple of buckets. This seeds the full 30 days that `samples` retains by
 * running the exact same SQL the tick uses, but with a 30-day lookback.
 *
 * Idempotent: rollups use ON CONFLICT DO UPDATE; the leaderboard precompute
 * does delete-then-insert of the recomputed buckets. Safe to re-run.
 */

import { createDb } from "@rpcbench/db";
import { loadEnv } from "@rpcbench/shared";
import { ensureGeoRegionMap, rollup1h, rollup1d, rollupLeaderboard } from "./rollup.js";

loadEnv(import.meta.url);

async function main() {
  // Direct (unpooled) connection — this is heavy, long-running batch work.
  const db = createDb({ mode: "direct" });

  console.log("[backfill] rollups_1h (30d)…");
  await rollup1h(db, "30 days");
  console.log("[backfill] rollups_1d (30d)…");
  await rollup1d(db, "30 days");

  console.log("[backfill] geo_region_map…");
  await ensureGeoRegionMap(db);

  console.log("[backfill] leaderboard_agg_1h / challenges_1h / failures_1h (30d)…");
  await rollupLeaderboard(db, "leaderboard_agg_1h", "leaderboard_challenges_1h", "leaderboard_failures_1h", "hour", "30 days");
  console.log("[backfill] leaderboard_agg_1d / challenges_1d / failures_1d (30d)…");
  await rollupLeaderboard(db, "leaderboard_agg_1d", "leaderboard_challenges_1d", "leaderboard_failures_1d", "day", "30 days");

  console.log("[backfill] done");
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] fatal", err);
  process.exit(1);
});
