import { sql } from "drizzle-orm";
import { createDb, type DbClient } from "@rpcbench/db";

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
 * (up to 18 min old) filled the pool and every page hung behind them. 15s is
 * far above a legitimate cold rollup read (hundreds of ms to a few s, see
 * docs/operations.md § Dashboard read latency) and well under any function
 * timeout.
 *
 * It must be SET LOCAL inside a transaction: Neon's transaction pooler drops
 * session-level SETs and rejects the startup-parameter form, so this is the
 * same pattern as the generator's withHeavyGucs. The cost is three extra round
 * trips (BEGIN, SET LOCAL, COMMIT) per uncached read.
 */
export const WEB_STATEMENT_TIMEOUT = "15s";
const SET_TIMEOUT = sql.raw(`SET LOCAL statement_timeout = '${WEB_STATEMENT_TIMEOUT}'`);

type Query = Parameters<DbClient["execute"]>[0];
type Rows = Awaited<ReturnType<DbClient["execute"]>>;

function boundedExecute(query: Query): Promise<Rows> {
  return client().transaction(async (tx) => {
    await tx.execute(SET_TIMEOUT);
    return tx.execute(query);
  });
}

/** The web app's only DB entry point: read-only `execute`, capped at
 *  WEB_STATEMENT_TIMEOUT per statement. */
export function db(): { execute: (query: Query) => Promise<Rows> } {
  return { execute: boundedExecute };
}

/**
 * Generic user-facing DB failure message. Pages render this instead of
 * err.message so driver/schema phrasing never reaches anonymous users;
 * the real error goes to console.error (server logs) in each catch.
 */
export const DB_ERROR_MESSAGE = "database temporarily unavailable — try again shortly";
