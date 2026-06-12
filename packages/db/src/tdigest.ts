/**
 * (Storage portability shim.)
 *
 * Originally these helpers wrapped the `tdigest` extension's aggregate
 * functions, but Neon's allowed-extensions list excludes tdigest. POC now
 * uses scalar p50/p95/p99 columns on rollups (computed via percentile_cont
 * in the rollup cron), and reads percentiles directly from `samples` for
 * the leaderboard view.
 *
 * Helpers below are kept as no-op placeholders so the API surface for
 * downstream callers stays stable. If we ever land somewhere with tdigest
 * (self-hosted Postgres, ClickHouse), this is the single file to swap.
 */

import { sql, type SQL } from "drizzle-orm";

/** Native percentile_cont over a numeric column. Reads scale linearly with |samples|. */
export function percentileFromColumn(column: SQL, percentile: number): SQL {
  return sql`percentile_cont(${percentile}) WITHIN GROUP (ORDER BY ${column})`;
}

/**
 * Approximate workload-mix p95 from pre-aggregated bucket p95s.
 *
 * Caveat: averaging p95s isn't a true workload p95. Used as a fast-path on
 * the dashboard for charts where the leaderboard's exact-from-samples query
 * would be too expensive. Labeled "approximate" in the UI when used.
 */
export function avgScalarPercentile(column: SQL): SQL {
  return sql`avg(${column})::real`;
}
