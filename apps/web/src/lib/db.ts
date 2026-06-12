import { createDb } from "@rpcbench/db";

let _db: ReturnType<typeof createDb> | null = null;

export function db() {
  if (_db) return _db;
  _db = createDb({ mode: "pooled" });
  return _db;
}

/**
 * Generic user-facing DB failure message. Pages render this instead of
 * err.message so driver/schema phrasing never reaches anonymous users;
 * the real error goes to console.error (server logs) in each catch.
 */
export const DB_ERROR_MESSAGE = "database temporarily unavailable — try again shortly";
