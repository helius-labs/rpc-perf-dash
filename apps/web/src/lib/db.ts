import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createDb, type DbClient } from "@rpcbench/db";
import { createBoundedReader } from "./boundedRead";

let _client: DbClient | null = null;

function client(): DbClient {
  if (_client) return _client;
  _client = createDb({ mode: "pooled" });
  return _client;
}

/**
 * Server-side cap on every web read. A Vercel function that times out does NOT
 * cancel its query, so before this cap an orphaned read kept running on Neon
 * for as long as it took. On 2026-10-19, hundreds of piled-up /challenges reads
 * (up to 18 min old) filled the pool and every page hung behind them.
 *
 * Two lanes (lib/boundedRead.ts): every read gets WEB_FAST_TIMEOUT_MS, far
 * above a normal cold rollup read (hundreds of ms to a few s, see
 * docs/operations.md § Dashboard read latency). A read that hits it is retried
 * once with WEB_SLOW_TIMEOUT_MS, at most WEB_MAX_SLOW_READS at a time per
 * instance, so valid-but-slow reads still complete and get cached while
 * runaways die. 15s + 40s stays under the function duration limit.
 *
 * The timeout must be SET LOCAL inside a transaction: Neon's transaction pooler
 * drops session-level SETs and rejects the startup-parameter form, so this is
 * the same pattern as the generator's withHeavyGucs. The cost is three extra
 * round trips (BEGIN, SET LOCAL, COMMIT) per uncached read.
 */
export const WEB_FAST_TIMEOUT_MS = 15_000;
export const WEB_SLOW_TIMEOUT_MS = 40_000;
const WEB_MAX_SLOW_READS = 2;

type Query = Parameters<DbClient["execute"]>[0];
type Rows = Awaited<ReturnType<DbClient["execute"]>>;

function runWithTimeout(query: Query, timeoutMs: number): Promise<Rows> {
  return client().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`));
    return tx.execute(query);
  });
}

const dialect = new PgDialect();

/** Identity of a read for the slow lane: its SQL text plus bound params. */
function queryKey(query: Query): string {
  if (typeof query === "string") return query;
  const { sql: text, params } = dialect.sqlToQuery(query.getSQL());
  return `${text}\u0000${JSON.stringify(params, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
}

const boundedExecute = createBoundedReader<Query, Rows>(runWithTimeout, queryKey, {
  fastMs: WEB_FAST_TIMEOUT_MS,
  slowMs: WEB_SLOW_TIMEOUT_MS,
  maxSlow: WEB_MAX_SLOW_READS,
  knownSlowLimit: 256,
});

/** The web app's only DB entry point: read-only `execute` under the two-lane
 *  statement timeout above. */
export function db(): { execute: (query: Query) => Promise<Rows> } {
  return { execute: boundedExecute };
}

/**
 * Generic user-facing DB failure message. Pages render this instead of
 * err.message so driver/schema phrasing never reaches anonymous users;
 * the real error goes to console.error (server logs) in each catch.
 */
export const DB_ERROR_MESSAGE = "database temporarily unavailable — try again shortly";
