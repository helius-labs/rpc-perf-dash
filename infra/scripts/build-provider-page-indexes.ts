/**
 * build-provider-page-indexes.ts — apply migration 0018's provider-selective
 * indexes to a LIVE database without locking the rollup writer's upsert path.
 *
 * rollups_5m / rollups_1h are continuously upserted by the rollup tick, so a
 * plain `CREATE INDEX` (what migration 0018 does on a fresh/empty DB) would hold
 * a write lock for the whole build. These tables are NOT partitioned, so each
 * index gets a direct CREATE INDEX CONCURRENTLY (no write lock) — same as the
 * challenges / leaderboard_agg path in build-time-indexes.ts.
 *
 * CONCURRENTLY can't run inside a transaction, so each statement is issued
 * separately (postgres.js, max:1). Idempotent: safe to re-run.
 *
 * After it finishes it records 0018 in schema_migrations so the plain (locking)
 * version in migrate.ts is skipped on this DB.
 *
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/build-provider-page-indexes.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

const MIGRATION_FILE = "0018_provider_page_indexes.sql";

const INDEXES: Array<{ name: string; table: string; cols: string }> = [
  {
    name: "rollups_5m_provider_chart_idx",
    table: "rollups_5m",
    cols: "(provider_id, connection_mode, method, window_start)",
  },
  {
    name: "rollups_1h_provider_window_idx",
    table: "rollups_1h",
    cols: "(provider_id, methodology_version, window_start)",
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

  // ── rollups_5m / rollups_1h: direct CONCURRENTLY (not partitioned) ──
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
