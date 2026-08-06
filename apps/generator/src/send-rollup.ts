/**
 * Send-archetype rollups: fold `landing_tx_results` → `send_rollups_5m` →
 * `send_rollups` (1h/1d) → `send_leaderboard_agg` (geo-blended). Runs on its OWN
 * intervals — never chained onto the read rollup tail (CLAUDE.md).
 *
 * The in-effect `priority_fee` is carried through as a rollup dimension so
 * cross-time landing-rate comparisons can normalize against the fee that
 * produced them (the fee is adaptive per tick).
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";
import { geoRegionValuesSql } from "./rollup.js";

/** Fold raw landing rows into a rollup table for one window grain. */
async function foldTier(
  db: DbClient,
  target: "send_rollups_5m" | "send_rollups",
  grain: "5m" | "1h" | "1d",
  /** Raw SQL for the window-start bucket (date_trunc for 1h/1d; epoch-floor for 5m). */
  bucketExpr: string,
  windowSql: string,
): Promise<void> {
  const grainCol = target === "send_rollups" ? sql.raw(`'${grain}' AS grain,`) : sql.raw("");
  const grainKey = target === "send_rollups" ? sql.raw("grain,") : sql.raw("");
  await db.execute(sql`
    INSERT INTO ${sql.raw(target)} (
      ${grainKey} send_target, scenario, worker_provider, region, methodology_version, window_start,
      sample_count_total, landed_count, reverted_count, not_landed_count, submit_error_count,
      landing_rate, slot_latency_p50, slot_latency_p95, wall_latency_p50, wall_latency_p95,
      cu_used_avg, cu_requested_avg,
      priority_fee_avg
    )
    SELECT
      ${grainCol} send_target, scenario, worker_provider, region, methodology_version,
      ${sql.raw(bucketExpr)} AS window_start,
      count(*)::int,
      count(*) FILTER (WHERE outcome = 'landed')::int,
      count(*) FILTER (WHERE outcome = 'reverted')::int,
      count(*) FILTER (WHERE outcome = 'not_landed')::int,
      count(*) FILTER (WHERE outcome = 'submit_error')::int,
      (count(*) FILTER (WHERE landed))::real / NULLIF(count(*), 0),
      percentile_cont(0.5) WITHIN GROUP (ORDER BY slot_latency)::int,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY slot_latency)::int,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY wall_latency_ms)::int,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY wall_latency_ms)::int,
      avg(cu_used)::real, avg(cu_requested)::real,
      avg(priority_fee)::bigint
    FROM landing_tx_results
    WHERE started_at >= ${sql.raw(windowSql)}
    GROUP BY send_target, scenario, worker_provider, region, methodology_version, window_start
    ON CONFLICT (${grainKey} send_target, scenario, worker_provider, region, methodology_version, window_start)
    DO UPDATE SET
      sample_count_total = EXCLUDED.sample_count_total,
      landed_count = EXCLUDED.landed_count,
      reverted_count = EXCLUDED.reverted_count,
      not_landed_count = EXCLUDED.not_landed_count,
      submit_error_count = EXCLUDED.submit_error_count,
      landing_rate = EXCLUDED.landing_rate,
      slot_latency_p50 = EXCLUDED.slot_latency_p50,
      slot_latency_p95 = EXCLUDED.slot_latency_p95,
      wall_latency_p50 = EXCLUDED.wall_latency_p50,
      wall_latency_p95 = EXCLUDED.wall_latency_p95,
      cu_used_avg = EXCLUDED.cu_used_avg,
      cu_requested_avg = EXCLUDED.cu_requested_avg,
      priority_fee_avg = EXCLUDED.priority_fee_avg
  `);
}

/** Fast tier: the last ~2 hours of 5-minute windows (epoch-floored to 300s). */
export async function runSendRollup5m(db: DbClient): Promise<void> {
  await foldTier(
    db,
    "send_rollups_5m",
    "5m",
    "to_timestamp(floor(extract(epoch from started_at) / 300) * 300)",
    "now() - interval '2 hours'",
  );
}

/** Heavy tiers: 1h (last 48h) + 1d (last 30d). */
export async function runSendHeavyRollups(db: DbClient): Promise<void> {
  await foldTier(db, "send_rollups", "1h", "date_trunc('hour', started_at)", "now() - interval '48 hours'");
  await foldTier(db, "send_rollups", "1d", "date_trunc('day', started_at)", "now() - interval '30 days'");
}

/**
 * Geo-blended leaderboard precompute from send_rollups. `region` → `geo` via the
 * inline GEO_REGION_MAP relation (same as the read board).
 */
export async function runSendLeaderboard(db: DbClient): Promise<void> {
  const grm = sql.raw(geoRegionValuesSql());
  for (const grain of ["1h", "1d"] as const) {
    await db.execute(sql`
      INSERT INTO send_leaderboard_agg (
        grain, geo, worker_provider, send_target, scenario, methodology_version, window_start,
        sample_count_total, landing_rate, slot_latency_p50, slot_latency_p95,
        wall_latency_p50, wall_latency_p95,
        cu_used_avg, cu_requested_avg, priority_fee_avg
      )
      SELECT
        r.grain, grm.geo, r.worker_provider, r.send_target, r.scenario,
        r.methodology_version, r.window_start,
        sum(r.sample_count_total)::int,
        sum(r.landed_count + r.reverted_count)::real / NULLIF(sum(r.sample_count_total), 0),
        max(r.slot_latency_p50), max(r.slot_latency_p95),
        max(r.wall_latency_p50), max(r.wall_latency_p95),
        avg(r.cu_used_avg)::real, avg(r.cu_requested_avg)::real,
        avg(r.priority_fee_avg)::bigint
      FROM send_rollups r
      JOIN ${grm}
        ON grm.worker_provider = r.worker_provider AND grm.region = r.region
      WHERE r.grain = ${grain}
      GROUP BY r.grain, grm.geo, r.worker_provider, r.send_target, r.scenario,
               r.methodology_version, r.window_start
      ON CONFLICT (grain, geo, worker_provider, send_target, scenario, methodology_version, window_start)
      DO UPDATE SET
        sample_count_total = EXCLUDED.sample_count_total,
        landing_rate = EXCLUDED.landing_rate,
        slot_latency_p50 = EXCLUDED.slot_latency_p50,
        slot_latency_p95 = EXCLUDED.slot_latency_p95,
        wall_latency_p50 = EXCLUDED.wall_latency_p50,
        wall_latency_p95 = EXCLUDED.wall_latency_p95,
        cu_used_avg = EXCLUDED.cu_used_avg,
        cu_requested_avg = EXCLUDED.cu_requested_avg,
        priority_fee_avg = EXCLUDED.priority_fee_avg
    `);
  }
}
