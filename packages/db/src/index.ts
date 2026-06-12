import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export interface DbOptions {
  /** Use the pooled (-pooler) URL for high-concurrency workers; direct for cron + migrations. */
  mode: "pooled" | "direct";
}

export function createDb(opts: DbOptions): DbClient {
  // Prefer NEON_DATABASE_URL_* (explicit names from .env.example), fall back
  // to Vercel-Neon-integration-provided DATABASE_URL / DATABASE_URL_UNPOOLED.
  const url =
    opts.mode === "pooled"
      ? process.env.NEON_DATABASE_URL_POOLED ?? process.env.DATABASE_URL
      : process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    const want = opts.mode === "pooled"
      ? "NEON_DATABASE_URL_POOLED or DATABASE_URL"
      : "NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED";
    throw new Error(`Missing ${want}`);
  }
  const sql = postgres(url, {
    max: opts.mode === "pooled" ? 20 : 4,
    prepare: false, // Neon's pooler runs in transaction mode — prepared statements not supported there.
  });
  return drizzle(sql, { schema });
}

export { schema };
export * from "./samples.js";
export * from "./rollups.js";
export * from "./control.js";
export * from "./consensus.js";
export * from "./tdigest.js";
