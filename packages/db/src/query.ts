import type { SQL } from "drizzle-orm";
import type { DbClient } from "./index.js";

/**
 * Run a raw SQL query and return its rows typed as `T[]`. Centralizes the
 * `as unknown as T[]` cast that raw `db.execute` results need (drizzle types
 * the result as a generic record set), so call sites stay typed and uniform.
 */
export async function executeRows<T>(db: DbClient, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/** Like {@link executeRows} but returns just the first row, or null. */
export async function firstRow<T>(db: DbClient, query: SQL): Promise<T | null> {
  const rows = await executeRows<T>(db, query);
  return rows[0] ?? null;
}
