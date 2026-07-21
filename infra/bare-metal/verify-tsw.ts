/**
 * verify-tsw.ts — confirms TeraSwitch vantages are heartbeating, getting
 * assignments, and writing samples after deploy-tsw.sh runs.
 *
 * Run via the db workspace so loadEnv() finds .env.local:
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/bare-metal/verify-tsw.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  console.log("\n── Heartbeats (expect 3 teraswitch rows, staleness < 10s):");
  const hb = await sql`
    SELECT worker_provider, region, egress_path, beat_at,
           extract(epoch from now() - beat_at)::int AS staleness_s
    FROM worker_heartbeat
    WHERE worker_provider = 'teraswitch'
    ORDER BY region
  `;
  console.table(hb);

  console.log("\n── Vantage fanout in last 5 min (expect both aws + teraswitch):");
  const fan = await sql`
    SELECT DISTINCT a.worker_provider, a.region
    FROM challenge_assignments a
    JOIN challenges c ON c.id = a.challenge_id
    WHERE c.generated_at > now() - interval '5 min'
    ORDER BY a.worker_provider, a.region
  `;
  console.table(fan);

  console.log("\n── Samples written in last 5 min (expect non-zero teraswitch rows):");
  const samples = await sql`
    SELECT worker_provider, region, count(*)::int AS samples_5min
    FROM samples
    WHERE started_at > now() - interval '5 min'
    GROUP BY worker_provider, region
    ORDER BY worker_provider, region
  `;
  console.table(samples);

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
