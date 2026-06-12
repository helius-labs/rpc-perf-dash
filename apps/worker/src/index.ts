// IMPORTANT: import order matters. early-bind binds port 8080 on module
// load, before any heavy imports. CF Containers' port check timeout is
// ~20s — long enough for AWS/TSW where the rest of the import chain takes
// ~1s, but tight on cold firecracker starts. Binding first guarantees we
// satisfy the healthcheck regardless of how slow drizzle/postgres/undici
// take to load.
import { status as earlyStatus } from "./early-bind.js";

import { sql } from "drizzle-orm";
import { createDb, insertConsensusLog, insertSamples } from "@rpcbench/db";
import { loadEnv, type Method } from "@rpcbench/shared";
import { fanout, buildSampleRowsV2, shouldArchive } from "@rpcbench/runner";
import { claimNext, markDone } from "./claim.js";
import { hostname } from "node:os";

earlyStatus.loaded_at = new Date().toISOString();
earlyStatus.phase = "loading";
process.stderr.write(`[worker] imports complete at ${earlyStatus.loaded_at}\n`);

// Load .env / .env.local from the repo root before reading process.env below.
loadEnv(import.meta.url);

const WORKER_PROVIDER = process.env.WORKER_PROVIDER ?? "aws";
// `let` because on CF we discover the real PoP at runtime and overwrite the
// env-var label ("global" → "yyz" etc.) before the first heartbeat. On
// AWS/TSW these stay at whatever the env-vars said.
let REGION = process.env.WORKER_REGION ?? "us-east-2";
let EGRESS_PATH = process.env.WORKER_EGRESS_PATH ?? "aws-nat-a";
// Empty string treated as unset (env files often have `WORKER_ID=` literal).
const WORKER_ID =
  process.env.WORKER_ID && process.env.WORKER_ID.length > 0
    ? process.env.WORKER_ID
    : `${hostname()}-${process.pid}`;
const HEARTBEAT_INTERVAL_MS = 5_000;
const POLL_IDLE_MS = 250;
const POLL_IDLE_JITTER_MS = 50;

// Populate early-bind status with our identity so the /healthcheck JSON is
// useful from the moment it's reachable.
earlyStatus.worker_id = WORKER_ID;
earlyStatus.worker_provider = WORKER_PROVIDER;
earlyStatus.region = REGION;
earlyStatus.egress_path = EGRESS_PATH;

/**
 * On CF we can't statically know which PoP CF placed our container at —
 * it's whatever CF's scheduler picked. Discover it via Cloudflare's own
 * trace endpoint: `cf-cgi/trace` returns a key=value text block where
 * `colo` is the 3-letter IATA code of the PoP handling the request.
 * From inside a CF Container, outbound requests go through the *same*
 * PoP the container is running at, so the trace response identifies the
 * container's actual location.
 *
 * Lowercased for consistency with TSW's (lowercase) site codes.
 * Returns null on non-CF or fetch failure (caller keeps the env-var default).
 */
async function detectCfPop(): Promise<string | null> {
  if (WORKER_PROVIDER !== "cloudflare") return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/^colo=(\w+)$/m);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Per-stage stderr timing. On CF this is the only way to see what the
// container is doing (wrangler tail doesn't surface container stdout) — so
// it's gated on the CF path. On AWS/TSW it's redundant with CloudWatch /
// journalctl and just adds noise, so we skip it there. Flip on anywhere
// via WORKER_TRACE=1 when debugging.
const TRACE_ENABLED =
  WORKER_PROVIDER === "cloudflare" || process.env.WORKER_TRACE === "1";

function trace(stage: string, extra = ""): void {
  if (!TRACE_ENABLED) return;
  process.stderr.write(`[trace ${stage}] ${extra}\n`);
}

async function processOne(db: ReturnType<typeof createDb>): Promise<boolean> {
  const tClaim0 = Date.now();
  const claimed = await claimNext(db, WORKER_PROVIDER, REGION, EGRESS_PATH, WORKER_ID);
  if (!claimed) return false;
  trace("claimed", `id=${claimed.challenge_id} method=${claimed.method} bucket=${claimed.bucket} dt=${Date.now() - tClaim0}ms`);

  if (claimed.expires_at.getTime() < Date.now()) {
    // Expired before we got here; mark and skip.
    await markDone(db, claimed.challenge_id, WORKER_PROVIDER, REGION, EGRESS_PATH);
    trace("expired_skip", `id=${claimed.challenge_id}`);
    return true;
  }

  const params = claimed.params as unknown[];
  const method = claimed.method as Method;
  const tFanout0 = Date.now();
  trace("fanout_start", `id=${claimed.challenge_id}`);
  const { results, provider_tip_slots } = await fanout(method, params);
  trace("fanout_done", `id=${claimed.challenge_id} dt=${Date.now() - tFanout0}ms n_results=${results.length}`);

  const built = buildSampleRowsV2({
    challenge_id: claimed.challenge_id,
    method,
    bucket: claimed.bucket,
    worker_provider: WORKER_PROVIDER,
    region: REGION,
    worker_id: WORKER_ID,
    egress_path: EGRESS_PATH,
    reference_hash: claimed.reference_hash,
    reference_response: claimed.reference_response,
    reference_tip_slot: claimed.reference_tip_slot,
    is_honeypot: claimed.is_honeypot,
    archive: shouldArchive(claimed.challenge_id),
    fanoutResults: results,
    provider_tip_slots,
    startedAt: new Date(),
  });

  if (built.rows.length > 0) {
    const tIns0 = Date.now();
    await insertSamples(db, built.rows);
    // Persist any consensus_log rows the runner decided to keep (disputed /
    // ambiguous / archive sample). Sequential to keep the insert pattern
    // simple — there's at most 2 rows per challenge (one per mode).
    for (const log of built.consensus_log) {
      await insertConsensusLog(db, log);
    }
    trace("insert_done", `n=${built.rows.length} dt=${Date.now() - tIns0}ms`);
    earlyStatus.last_sample_at = new Date().toISOString();
    earlyStatus.phase = "sampling";
  }
  const tDone0 = Date.now();
  await markDone(db, claimed.challenge_id, WORKER_PROVIDER, REGION, EGRESS_PATH);
  trace("markDone", `id=${claimed.challenge_id} dt=${Date.now() - tDone0}ms`);
  return true;
}

async function heartbeat(db: ReturnType<typeof createDb>): Promise<void> {
  await db.execute(sql`
    INSERT INTO worker_heartbeat (worker_id, worker_provider, region, egress_path, pid, beat_at)
    VALUES (${WORKER_ID}, ${WORKER_PROVIDER}, ${REGION}, ${EGRESS_PATH}, ${process.pid}, now())
    ON CONFLICT (worker_id) DO UPDATE
      SET worker_provider = EXCLUDED.worker_provider,
          region = EXCLUDED.region,
          egress_path = EXCLUDED.egress_path,
          pid = EXCLUDED.pid,
          beat_at = now()
  `);
}

async function main() {
  const db = createDb({ mode: "pooled" });

  // On CF: discover the actual PoP before we start heartbeating with
  // the wrong identity. On AWS/TSW: no-op, env vars stay authoritative.
  const pop = await detectCfPop();
  if (pop) {
    REGION = pop;
    EGRESS_PATH = `cf-${pop}`;
    earlyStatus.region = REGION;
    earlyStatus.egress_path = EGRESS_PATH;
    console.log(`[worker] detected CF PoP: ${pop}`);
  }

  console.log(
    `[worker ${WORKER_ID}] provider=${WORKER_PROVIDER} region=${REGION} egress=${EGRESS_PATH} starting`,
  );

  setInterval(() => heartbeat(db).catch(() => {}), HEARTBEAT_INTERVAL_MS);
  earlyStatus.phase = "ready";
  // Health HTTP server was already bound at module load (./early-bind).
  // Nothing more to start here.

  while (true) {
    try {
      const did = await processOne(db);
      if (!did) {
        // ±50ms jitter on the idle branch only — the hot path is already
        // DB-bound and non-periodic, but a strict 250ms idle backoff is the
        // only timing signal a provider could observe across requests.
        const jitter = Math.floor((Math.random() * 2 - 1) * POLL_IDLE_JITTER_MS);
        await new Promise((r) => setTimeout(r, POLL_IDLE_MS + jitter));
      }
    } catch (err) {
      console.error("[worker]", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
