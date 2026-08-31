import postgres from "postgres";
import fs from "node:fs";
function loadEnv(f: string) { const o: Record<string,string> = {};
  if (!fs.existsSync(f)) return o;
  for (const l of fs.readFileSync(f,"utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g,""); } return o; }
const e = { ...loadEnv(".env.local"), ...loadEnv(".env") };
const sql = postgres((e.NEON_DATABASE_URL_DIRECT || e.NEON_DATABASE_URL || e.DATABASE_URL)!, { ssl: "require", max: 1 });
console.log("— ALL cloudflare heartbeat rows, newest first —");
console.table(await sql`SELECT worker_id, region, pid, beat_at::text, age(now(), beat_at)::text AS age
  FROM worker_heartbeat WHERE worker_provider='cloudflare' ORDER BY beat_at DESC LIMIT 12`);
console.log("— last cloudflare sample —");
console.table(await sql`SELECT max(started_at)::text AS last_sample, age(now(), max(started_at))::text AS ago
  FROM samples WHERE worker_provider='cloudflare'`);
await sql.end();
