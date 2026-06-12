import { createDb } from "@rpcbench/db";

let _db: ReturnType<typeof createDb> | null = null;

export function db() {
  if (_db) return _db;
  _db = createDb({ mode: "pooled" });
  return _db;
}
