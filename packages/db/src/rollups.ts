/**
 * Narrow interface for rollups + dashboard reads.
 *
 * t-digest reads go through `tdigest_merge_p95` so a future swap to ClickHouse
 * (where `quantileTDigestMerge` replaces this) is a single-file change.
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "./index.js";

export interface RollupSelector {
  provider_ids?: readonly string[];
  methods?: readonly string[];
  regions?: readonly string[];
  buckets?: readonly string[];
  connection_mode: "cold" | "warm";
  methodology_version: number;
  window_after: Date;
}

export interface ProviderRollupAggregate {
  provider_id: string;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  stddev_ms: number;
  sample_count_total: number;
  sample_count_valid: number;
  sample_count_excluded: number;
  success_rate: number;
  correctness_rate: number;
  completeness_rate: number;
  freshness_p95_lag: number;
  honeypot_pass_count: number;
  honeypot_total: number;
}

/**
 * Merge t-digests across selected (method × bucket) at query time and return
 * provider-level aggregates suitable for the leaderboard.
 *
 * Reads from `rollups_1h` by default — coarser grain (`rollups_1d`) auto-falls-back
 * for very long windows in the calling code.
 */
export async function leaderboardAggregates(
  db: DbClient,
  selector: RollupSelector,
): Promise<ProviderRollupAggregate[]> {
  const filters: any[] = [
    sql`connection_mode = ${selector.connection_mode}`,
    sql`methodology_version = ${selector.methodology_version}`,
    sql`window_start > ${selector.window_after}`,
  ];
  // postgres-js can't bind a JS array to a SQL ANY(array) parameter without
  // explicit type info, so build IN (...) clauses with literal interpolation.
  // Inputs are caller-controlled values from our own constants/registries —
  // not user input — but we still SQL-escape defensively.
  const inList = (vals: readonly string[]) =>
    sql.raw(`(${vals.map((v) => `'${v.replace(/'/g, "''")}'`).join(",")})`);
  if (selector.provider_ids?.length) {
    filters.push(sql`provider_id IN ${inList(selector.provider_ids)}`);
  }
  if (selector.methods?.length) {
    filters.push(sql`method IN ${inList(selector.methods)}`);
  }
  if (selector.regions?.length) {
    filters.push(sql`region IN ${inList(selector.regions)}`);
  }
  if (selector.buckets?.length) {
    filters.push(sql`bucket IN ${inList(selector.buckets)}`);
  }

  const where = filters.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} AND ${f}`));

  // Reads from rollups_1h's pre-aggregated p50/p95/p99 columns. Note these are
  // per-bucket exact percentiles; averaging across buckets here is approximate.
  // Leaderboard uses the dashboard's exact-from-samples query for the canonical
  // ranking; this helper is for non-load-bearing time-series displays.
  const rows = await db.execute(sql`
    SELECT
      provider_id,
      avg(latency_p50)::int AS p50_ms,
      avg(latency_p95)::int AS p95_ms,
      avg(latency_p99)::int AS p99_ms,
      avg(latency_stddev)::real AS stddev_ms,
      sum(sample_count_total)::int                                  AS sample_count_total,
      sum(sample_count_valid)::int                                  AS sample_count_valid,
      sum(sample_count_excluded)::int                               AS sample_count_excluded,
      avg(success_rate)::real                                       AS success_rate,
      avg(correctness_rate)::real                                   AS correctness_rate,
      avg(completeness_rate)::real                                  AS completeness_rate,
      max(freshness_p95_lag)::int                                   AS freshness_p95_lag,
      sum(honeypot_pass_count)::int                                 AS honeypot_pass_count,
      sum(honeypot_total)::int                                      AS honeypot_total
    FROM rollups_1h
    WHERE ${where}
    GROUP BY provider_id
  `);
  return rows as unknown as ProviderRollupAggregate[];
}
