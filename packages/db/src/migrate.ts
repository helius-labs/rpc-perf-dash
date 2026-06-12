/**
 * Apply hand-written SQL migrations from src/migrations/ in order.
 *
 * Drizzle's migrator only handles tables it generates; we own the schema
 * directly because of partitioning and other hand-written DDL. So this is a
 * minimal manual migrator.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const dir = join(import.meta.dirname, "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const f of files) {
    const [{ exists } = { exists: false }] = await sql`
      SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = ${f}) AS exists
    `;
    if (exists) {
      console.log(`skip  ${f} (already applied)`);
      continue;
    }
    const text = await readFile(join(dir, f), "utf8");
    console.log(`apply ${f}`);
    await sql.unsafe(text);
    await sql`INSERT INTO schema_migrations (filename) VALUES (${f})`;
  }

  await sql.end();
  console.log("migrations complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
