/**
 * build-provider-breakdown-index.ts — apply migration 0023's provider-leading
 * index on leaderboard_agg_1h to a LIVE database without locking the rollup
 * writer's upsert path.
 *
 * leaderboard_agg_1h is continuously upserted by the rollup tick, so a plain
 * `CREATE INDEX` (what migration 0023 does on a fresh/empty DB) would hold a
 * write lock for the whole build. The table is NOT partitioned, so the index
 * gets a direct CREATE INDEX CONCURRENTLY (no write lock) — same as the
 * build-provider-page-indexes.ts path.
 *
 * CONCURRENTLY can't run inside a transaction, so each statement is issued
 * separately (postgres.js, max:1). Idempotent: safe to re-run.
 *
 * After it finishes it records 0023 in schema_migrations so the plain (locking)
 * version in migrate.ts is skipped on this DB.
 *
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/build-provider-breakdown-index.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

const MIGRATION_FILE = "0023_provider_breakdown_index.sql";

const INDEXES: Array<{ name: string; table: string; cols: string }> = [
  {
    name: "leaderboard_agg_1h_provider_method_idx",
    table: "leaderboard_agg_1h",
    cols: "(provider_id, worker_provider, connection_mode, methodology_version, window_start)",
  },
];

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  const step = async (label: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    await fn();
    console.log(`  ✓ ${label} (${Date.now() - t0}ms)`);
  };

  // ── leaderboard_agg_1h: direct CONCURRENTLY (not partitioned) ──
  for (const ix of INDEXES) {
    await step(ix.name, () =>
      sql.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ix.name} ON ${ix.table} ${ix.cols}`,
      ),
    );
  }

  // Record the migration so migrate.ts skips the locking plain-CREATE version.
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`
    INSERT INTO schema_migrations (filename) VALUES (${MIGRATION_FILE})
    ON CONFLICT (filename) DO NOTHING`;
  console.log(`  ✓ recorded ${MIGRATION_FILE} in schema_migrations`);

  await sql.end();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
