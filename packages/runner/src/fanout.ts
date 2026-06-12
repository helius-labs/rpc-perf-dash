/**
 * Fan-out the benchmark call across all 4 benchmarked providers,
 * concurrently producing both cold and warm samples.
 *
 * Cold: fresh socket per request (timing.ts).
 * Warm: per-provider serialized HTTP/2 pool (one in-flight at a time per provider/worker).
 */

import { Agent, Pool, request } from "undici";
import {
  CONFIGURED_BENCHMARKED,
  resolveEndpointUrl,
  timedColdPost,
  type Method,
} from "@rpcbench/shared";
import { HANDLERS } from "@rpcbench/methods";
import { lookup } from "node:dns/promises";

const TIMEOUT_MS = 5000;

// Gate per-provider stderr lines. On CF we lose wrangler-tail visibility
// into container output, so these are how we see latency-distribution per
// provider when debugging. On AWS/TSW they're redundant with sample-level
// data already written to Postgres, so we skip them. Toggle on anywhere
// via WORKER_TRACE=1.
const TRACE_ENABLED =
  process.env.WORKER_PROVIDER === "cloudflare" ||
  process.env.WORKER_TRACE === "1";

function traced(providerId: string, kind: "cold" | "warm" | "slot") {
  return (r: SingleResult): SingleResult => {
    if (TRACE_ENABLED) {
      process.stderr.write(
        `[fanout] ${providerId} ${kind} ${r.status} ${r.latency_ms}ms err=${r.error_code ?? ""}\n`,
      );
    }
    return r;
  };
}

export interface ProviderCallResult {
  provider_id: string;
  endpoint_used: string;
  cold: SingleResult;
  warm: SingleResult;
}

export interface SingleResult {
  latency_ms: number;
  status: "ok" | "error" | "timeout";
  http_status: number | null;
  error_code: string | null;
  /** Raw response body string (parsed by caller for projection). */
  body: string | null;
}

// DNS cache with TTL. Without expiry, IP rotations on provider edges (Cloudflare
// healing, weighted DNS rebalances) leave workers stuck on stale IPs for the
// container's full lifetime — which can be days. 5 min matches typical edge TTLs.
const DNS_TTL_MS = 5 * 60 * 1000;
interface DnsEntry {
  address: string;
  expires_at: number;
}
const DNS_CACHE = new Map<string, DnsEntry>();

// Per-origin pools: one Pool reused across challenges. allowH2 lets undici
// pick HTTP/2 if the server supports it; the connection stays open across
// challenges so "warm" actually skips TLS+TCP setup.
const WARM_POOLS = new Map<string, Pool>();
// Per-origin lock for the BENCHMARK warm call only. The slot-probe warm call
// (piggybacked) does NOT share this lock — it uses a separate side pool so the
// probe never blocks the next benchmark's warm slot.
const WARM_LOCKS = new Map<string, Promise<void>>();
const SLOT_POOLS = new Map<string, Pool>();

async function resolveDns(host: string): Promise<string> {
  const now = Date.now();
  const cached = DNS_CACHE.get(host);
  if (cached && cached.expires_at > now) return cached.address;
  const { address } = await lookup(host, { family: 4 });
  DNS_CACHE.set(host, { address, expires_at: now + DNS_TTL_MS });
  return address;
}

function warmPoolFor(originUrl: string): Pool {
  let pool = WARM_POOLS.get(originUrl);
  if (!pool) {
    const u = new URL(originUrl);
    pool = new Pool(`${u.protocol}//${u.host}`, { connections: 1, allowH2: true });
    WARM_POOLS.set(originUrl, pool);
  }
  return pool;
}

function slotPoolFor(originUrl: string): Pool {
  let pool = SLOT_POOLS.get(originUrl);
  if (!pool) {
    const u = new URL(originUrl);
    pool = new Pool(`${u.protocol}//${u.host}`, { connections: 1, allowH2: true });
    SLOT_POOLS.set(originUrl, pool);
  }
  return pool;
}

/**
 * Read a response body off undici's stream while capturing the first-byte
 * timestamp. We need both: latency = first-byte for the methodology, and the
 * full body for downstream projection/classification. Equivalent of the cold
 * path's `firstByteTs` capture.
 */
async function drainWithFirstByte(
  body: NodeJS.ReadableStream,
): Promise<{ buffer: Buffer; first_byte_ms: number | null }> {
  const chunks: Buffer[] = [];
  let firstByte: number | null = null;
  await new Promise<void>((resolve, reject) => {
    body.on("data", (chunk: Buffer) => {
      if (firstByte === null) firstByte = performance.now();
      chunks.push(chunk);
    });
    body.on("end", () => resolve());
    body.on("error", (err) => reject(err));
  });
  return { buffer: Buffer.concat(chunks), first_byte_ms: firstByte };
}

async function warmCallBenchmark(originUrl: string, body: string): Promise<SingleResult> {
  // Serialize per origin so we don't get head-of-line blocking distortion in
  // the latency measurement. The slot-probe call deliberately bypasses this
  // lock (separate pool) so it doesn't add wait time to subsequent benchmarks.
  while (WARM_LOCKS.has(originUrl)) {
    await WARM_LOCKS.get(originUrl);
  }
  let resolveLock!: () => void;
  WARM_LOCKS.set(originUrl, new Promise((r) => (resolveLock = r)));

  try {
    return await doWarmRequest(warmPoolFor(originUrl), originUrl, body);
  } finally {
    resolveLock();
    WARM_LOCKS.delete(originUrl);
  }
}

async function warmCallSlot(originUrl: string, body: string): Promise<SingleResult> {
  // No lock — uses a side pool so it doesn't block benchmark calls.
  return await doWarmRequest(slotPoolFor(originUrl), originUrl, body);
}

async function doWarmRequest(pool: Pool, originUrl: string, body: string): Promise<SingleResult> {
  const u = new URL(originUrl);
  const path = u.pathname + u.search;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await pool.request({
      path,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    // Methodology: warm latency = first-byte time, same as cold. The body is
    // drained for the JSON payload but the timer stops at the first chunk.
    const { buffer, first_byte_ms } = await drainWithFirstByte(res.body);
    const latency = Math.round((first_byte_ms ?? performance.now()) - t0);
    return {
      latency_ms: latency,
      status: "ok",
      http_status: res.statusCode,
      error_code: null,
      body: buffer.toString("utf8"),
    };
  } catch (err) {
    const latency = Math.round(performance.now() - t0);
    const isTimeout = ctrl.signal.aborted;
    return {
      latency_ms: latency,
      status: isTimeout ? "timeout" : "error",
      http_status: null,
      error_code: (err as Error).message,
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function coldCall(originUrl: string, body: string): Promise<SingleResult> {
  const u = new URL(originUrl);
  try {
    const ip = await resolveDns(u.hostname);
    const r = await timedColdPost({
      url: u,
      body,
      headers: {},
      timeoutMs: TIMEOUT_MS,
      resolvedIp: ip,
    });
    return {
      latency_ms: Math.round(r.latency_ms),
      status: "ok",
      http_status: r.http_status,
      error_code: null,
      body: r.body,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      latency_ms: TIMEOUT_MS,
      status: msg === "timeout" ? "timeout" : "error",
      http_status: null,
      error_code: msg,
      body: null,
    };
  }
}

/** Issue cold + warm + piggybacked getSlot for each benchmarked provider, in parallel. */
export async function fanout(
  method: Method,
  params: unknown[],
): Promise<{ results: ProviderCallResult[]; provider_tip_slots: Map<string, bigint> }> {
  const reqBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const slotBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "getSlot",
    params: [{ commitment: "finalized" }],
  });

  const provider_tip_slots = new Map<string, bigint>();

  const results = await Promise.all(
    CONFIGURED_BENCHMARKED().map(async (p): Promise<ProviderCallResult> => {
      // Every benchmarked provider currently configures exactly one endpoint
      // (`packages/shared/src/providers.ts`); the earlier random-endpoint
      // cycling stub was a no-op and made the methodology claim a defense
      // that wasn't running. Revive multi-endpoint cycling here only if a
      // provider publishes confirmed-equivalent alternates.
      const url = resolveEndpointUrl(p.endpoints[0]!);
      if (!url) {
        const empty: SingleResult = { latency_ms: 0, status: "error", http_status: null, error_code: "no_url", body: null };
        return { provider_id: p.id, endpoint_used: "", cold: empty, warm: empty };
      }
      const [cold, warm, slotRes] = await Promise.all([
        coldCall(url, reqBody).then(traced(p.id, "cold")),
        warmCallBenchmark(url, reqBody).then(traced(p.id, "warm")),
        warmCallSlot(url, slotBody)
          .then(traced(p.id, "slot"))
          .catch((e) => {
            if (TRACE_ENABLED) {
              process.stderr.write(`[fanout] ${p.id} slot REJECT ${(e as Error).message}\n`);
            }
            return null;
          }),
      ]);

      if (slotRes?.body) {
        try {
          const parsed = JSON.parse(slotRes.body) as { result?: number };
          if (typeof parsed.result === "number") {
            provider_tip_slots.set(p.id, BigInt(parsed.result));
          }
        } catch {
          // ignore
        }
      }

      return {
        provider_id: p.id,
        endpoint_used: url,
        cold,
        warm,
      };
    }),
  );

  return { results, provider_tip_slots };
}

void HANDLERS; // keep handler imports referenced (used in classify path)
void Agent; // imported for h2 capability via Pool option
