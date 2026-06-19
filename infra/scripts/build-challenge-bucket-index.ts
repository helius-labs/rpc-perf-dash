/**
 * build-challenge-bucket-index.ts — apply migration 0024's bucket-leading index
 * to a LIVE database without locking the generator's insert path.
 *
 * `challenges` is written continuously, so a plain `CREATE INDEX ON challenges`
 * (what migration 0024 does on a fresh/empty DB) would hold a write lock for the
 * whole build. `challenges` is not partitioned, so we just need a direct
 * CONCURRENTLY (same as the non-partitioned tables in build-time-indexes.ts).
 *
 * CONCURRENTLY can't run inside a transaction, so the statement is issued on its
 * own connection (postgres.js, max:1). Idempotent: safe to re-run.
 *
 * After it finishes it records 0024 in schema_migrations so the plain (locking)
 * version in migrate.ts is skipped on this DB.
 *
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/build-challenge-bucket-index.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

const MIGRATION_FILE = "0024_challenge_bucket_index.sql";

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  const step = async (label: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    await fn();
    console.log(`  ✓ ${label} (${Date.now() - t0}ms)`);
  };

  // challenges is not partitioned → direct CONCURRENTLY.
  await step("challenges_bucket_idx", () =>
    sql.unsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS challenges_bucket_idx ON challenges (bucket text_pattern_ops, generated_at DESC)`,
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
