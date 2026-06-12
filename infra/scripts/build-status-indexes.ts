/**
 * build-status-indexes.ts — apply migration 0015's index to a LIVE database
 * without locking the continuous assignment-insert path.
 *
 * `challenge_assignments` is written continuously by the generator (one row per
 * (challenge, vantage) fanned out each dispatch tick), so a plain
 * `CREATE INDEX ON challenge_assignments` (what migration 0015 does on a
 * fresh/empty DB) would hold a write lock for the whole build. The table is NOT
 * partitioned, so — like the rollups branch of build-dashboard-indexes.ts — a
 * direct CREATE INDEX CONCURRENTLY is the zero-downtime path.
 *
 * CONCURRENTLY can't run inside a transaction, so the statement is issued on its
 * own (postgres.js, max:1). Idempotent: safe to re-run.
 *
 * After it finishes it records 0015 in schema_migrations so the plain (locking)
 * version in migrate.ts is skipped on this DB.
 *
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/build-status-indexes.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

const MIGRATION_FILE = "0015_status_indexes.sql";

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  const step = async (label: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    await fn();
    console.log(`  ✓ ${label} (${Date.now() - t0}ms)`);
  };

  // challenge_assignments: direct CONCURRENTLY (not partitioned).
  await step("assignments_claimed_at_idx", () =>
    sql.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS assignments_claimed_at_idx ON challenge_assignments (claimed_at)`,
    ),
  );

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
