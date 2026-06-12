/**
 * build-dashboard-indexes.ts — apply migration 0011's indexes to a LIVE database
 * without locking the continuous sample-insert path.
 *
 * `samples` is partitioned and written continuously, so a plain
 * `CREATE INDEX ON samples` (what migration 0011 does on a fresh/empty DB) would
 * hold a write lock across all partitions for the whole ~6M-row build. Instead
 * we build each partition's index with CREATE INDEX CONCURRENTLY (no write lock)
 * and ATTACH it to an ON ONLY parent index — the standard zero-downtime pattern
 * for partitioned tables. The rollups tables aren't partitioned, so they get a
 * direct CREATE INDEX CONCURRENTLY.
 *
 * CONCURRENTLY can't run inside a transaction, so each statement is issued
 * separately (postgres.js, max:1). Idempotent: safe to re-run.
 *
 * After it finishes it records 0011 in schema_migrations so the plain (locking)
 * version in migrate.ts is skipped on this DB.
 *
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/build-dashboard-indexes.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

const SAMPLES_COLS = "(connection_mode, method, started_at)";
const ROLLUP_COLS = "(connection_mode, method, window_start)";
const MIGRATION_FILE = "0011_dashboard_indexes.sql";

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  const step = async (label: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    await fn();
    console.log(`  ✓ ${label} (${Date.now() - t0}ms)`);
  };

  // ── rollups: direct CONCURRENTLY (not partitioned) ──────────────────────
  for (const tbl of ["rollups_5m", "rollups_1h", "rollups_1d"]) {
    await step(`${tbl}_dash_idx`, () =>
      sql.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${tbl}_dash_idx ON ${tbl} ${ROLLUP_COLS}`,
      ),
    );
  }

  // ── samples: ON ONLY parent + per-partition concurrent build + ATTACH ───
  await step("samples_dash_idx (parent, ON ONLY)", () =>
    sql.unsafe(`CREATE INDEX IF NOT EXISTS samples_dash_idx ON ONLY samples ${SAMPLES_COLS}`),
  );

  const partitions = (await sql<Array<{ part: string }>>`
    SELECT inhrelid::regclass::text AS part
    FROM pg_inherits WHERE inhparent = 'samples'::regclass
    ORDER BY 1
  `).map((r) => r.part);
  console.log(`  samples partitions: ${partitions.length}`);

  for (const part of partitions) {
    const child = `${part}_dash_idx`;
    await step(`${child} (concurrent build)`, () =>
      sql.unsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${child} ON ${part} ${SAMPLES_COLS}`,
      ),
    );
    // ATTACH is idempotent-guarded: skip if this child is already a partition
    // of the parent index.
    const attached = await sql`
      SELECT 1 FROM pg_inherits
      WHERE inhrelid = ${child}::regclass AND inhparent = 'samples_dash_idx'::regclass
    `;
    if (attached.length === 0) {
      await step(`ATTACH ${child}`, () =>
        sql.unsafe(`ALTER INDEX samples_dash_idx ATTACH PARTITION ${child}`),
      );
    } else {
      console.log(`  · ${child} already attached`);
    }
  }

  // Parent index is valid once every partition is attached.
  const [{ indisvalid } = { indisvalid: false }] = await sql<Array<{ indisvalid: boolean }>>`
    SELECT indisvalid FROM pg_index WHERE indexrelid = 'samples_dash_idx'::regclass
  `;
  console.log(`  samples_dash_idx valid: ${indisvalid}`);

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
