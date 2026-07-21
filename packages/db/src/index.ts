import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export interface DbOptions {
  /** Use the pooled (-pooler) URL for high-concurrency workers; direct for cron + migrations. */
  mode: "pooled" | "direct";
  /**
   * Override the connection-pool size. Defaults to 20 (pooled) / 4 (direct).
   * The generator's leader-lock client sets `max: 1` so the session-scoped
   * advisory lock, heartbeat, and lock-ownership check all run on one persistent
   * connection (see apps/generator/src/index.ts).
   */
  max?: number;
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
  // NOTE: statement_timeout is NOT set here. Neon's transaction pooler rejects
  // it as a startup parameter ("unsupported startup parameter"), and the
  // postgres.js `connection: { statement_timeout }` form is silently ignored
  // over the pooler. The web-read ceiling is instead a role-level GUC set once
  // on the DIRECT connection (`ALTER ROLE ... SET statement_timeout='15s'`) —
  // see docs/operations.md § Dashboard read latency. The generator overrides it
  // per-heavy-job via SET LOCAL, so its 600s builds are unaffected.
  const sql = postgres(url, {
    max: opts.max ?? (opts.mode === "pooled" ? 20 : 4),
    prepare: false, // Neon's pooler runs in transaction mode — prepared statements not supported there.
    // A connect that never completes must fail fast rather than hang the caller.
    connect_timeout: 15,
    // Root-cause prevention for the worker wedge: a pooled connection left idle
    // past a NAT gateway's ~350s idle drop goes half-open, so the next query
    // hangs forever (see apps/worker/src/watchdog.ts, which recovers from it).
    // Recycling idle pooled connections well under that keeps them from ever
    // reaching the half-open state. POOLED ONLY — `direct` mode carries the
    // generator's leader advisory lock on a persistent session (the lock client
    // is created with max:1 in apps/generator/src/index.ts); idling that
    // connection out would release the lock and flap leadership.
    ...(opts.mode === "pooled" ? { idle_timeout: 60 } : {}),
  });
  return drizzle(sql, { schema });
}

export { schema };
export * from "./query.js";
export * from "./samples.js";
export * from "./control.js";
export * from "./consensus.js";
