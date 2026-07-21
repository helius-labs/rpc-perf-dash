/**
 * Fan-out one benchmark call across the user's BYO endpoints, producing cold +
 * warm samples plus each provider's tip slot (for freshness).
 *
 * This is a standalone re-implementation of packages/runner/src/fanout.ts. We
 * cannot reuse `fanout()` directly because it hardwires its panel to
 * `CONFIGURED_BENCHMARKED()` (the env-driven roster); here the panel is the
 * user's own endpoint list. The cold/warm timing helpers are copied so the
 * measurement methodology (cold = fresh socket first-byte; warm = per-origin
 * HTTP/2 pool, serialized) matches production exactly. The result shape
 * (`ProviderCallResult`) is imported type-only from the runner so it can never
 * drift from what `buildSampleRows` consumes.
 */

import { Pool } from "undici";
import { redactEndpointUrl, timedColdPost } from "@rpcbench/shared";
import type { ProviderCallResult, SingleResult } from "@rpcbench/runner/fanout";
import { lookup } from "node:dns/promises";

const TIMEOUT_MS = 5000;

/**
 * Bucket-aware fanout budget (inlined from the runner's `fanoutTimeoutForBucket`
 * to avoid importing the registry-bound fanout module). Archival buckets and
 * honeypots hit cold archive storage; at the 5s default they'd mass-timeout.
 */
const ARCHIVAL_FANOUT_TIMEOUT_MS = 10_000;
export function fanoutTimeoutForBucket(bucket: string): number {
  return bucket === "honeypot" || bucket.includes("archival")
    ? ARCHIVAL_FANOUT_TIMEOUT_MS
    : TIMEOUT_MS;
}

/** A user-supplied endpoint. `id` is a synthetic `byo-<n>` (never the roster). */
export interface BenchProvider {
  id: string;
  name: string;
  url: string;
}

function fromHttpResponse(
  latency_ms: number,
  http_status: number,
  body: string,
  timeout_ms: number,
): SingleResult {
  // An HTTP status >= 400 is not a valid JSON-RPC answer — it's an
  // infrastructure/reliability failure, never a correctness vote. Mark it
  // "error" and drop the body so it never enters consensus projection.
  const httpError = http_status >= 400;
  return {
    latency_ms,
    status: httpError ? "error" : "ok",
    http_status,
    error_code: httpError ? `http_${http_status}` : null,
    body: httpError ? null : body,
    timeout_ms,
  };
}

// DNS cache with TTL — matches the runner (5 min ~ typical edge TTLs).
const DNS_TTL_MS = 5 * 60 * 1000;
interface DnsEntry {
  address: string;
  expires_at: number;
}
const DNS_CACHE = new Map<string, DnsEntry>();

const WARM_POOLS = new Map<string, Pool>();
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

async function warmCallBenchmark(
  originUrl: string,
  body: string,
  timeoutMs: number,
): Promise<SingleResult> {
  // Serialize per origin so we don't get head-of-line blocking distortion in the
  // latency measurement. The slot-probe call bypasses this lock (separate pool).
  while (WARM_LOCKS.has(originUrl)) {
    await WARM_LOCKS.get(originUrl);
  }
  let resolveLock!: () => void;
  WARM_LOCKS.set(originUrl, new Promise((r) => (resolveLock = r)));
  try {
    return await doWarmRequest(warmPoolFor(originUrl), originUrl, body, timeoutMs);
  } finally {
    resolveLock();
    WARM_LOCKS.delete(originUrl);
  }
}

async function warmCallSlot(originUrl: string, body: string): Promise<SingleResult> {
  return await doWarmRequest(slotPoolFor(originUrl), originUrl, body, TIMEOUT_MS);
}

async function doWarmRequest(
  pool: Pool,
  originUrl: string,
  body: string,
  timeoutMs: number,
): Promise<SingleResult> {
  const u = new URL(originUrl);
  const path = u.pathname + u.search;
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await pool.request({
      path,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    // Warm latency = first-byte time, same as cold. Body is drained for the
    // JSON payload but the timer stops at the first chunk.
    const { buffer, first_byte_ms } = await drainWithFirstByte(res.body);
    const latency = Math.round((first_byte_ms ?? performance.now()) - t0);
    return fromHttpResponse(latency, res.statusCode, buffer.toString("utf8"), timeoutMs);
  } catch (err) {
    const latency = Math.round(performance.now() - t0);
    const isTimeout = ctrl.signal.aborted;
    return {
      latency_ms: latency,
      status: isTimeout ? "timeout" : "error",
      http_status: null,
      error_code: (err as Error).message,
      body: null,
      timeout_ms: timeoutMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function coldCall(originUrl: string, body: string, timeoutMs: number): Promise<SingleResult> {
  const u = new URL(originUrl);
  try {
    const ip = await resolveDns(u.hostname);
    const r = await timedColdPost({
      url: u,
      body,
      headers: {},
      timeoutMs,
      resolvedIp: ip,
    });
    return fromHttpResponse(Math.round(r.latency_ms), r.http_status, r.body, timeoutMs);
  } catch (err) {
    const msg = (err as Error).message;
    return {
      latency_ms: timeoutMs,
      status: msg === "timeout" ? "timeout" : "error",
      http_status: null,
      error_code: msg,
      body: null,
      timeout_ms: timeoutMs,
    };
  }
}

/**
 * Fan-out `method(params)` across the given providers, concurrently producing
 * cold + warm samples and each provider's finalized tip slot.
 */
export async function fanout(
  method: string,
  params: unknown[],
  providers: readonly BenchProvider[],
  opts?: { timeoutMs?: number },
): Promise<{ results: ProviderCallResult[]; provider_tip_slots: Map<string, bigint> }> {
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  const reqBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const slotBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "getSlot",
    params: [{ commitment: "finalized" }],
  });

  const provider_tip_slots = new Map<string, bigint>();

  const results = await Promise.all(
    providers.map(async (p): Promise<ProviderCallResult> => {
      const [cold, warm, slotRes] = await Promise.all([
        coldCall(p.url, reqBody, timeoutMs),
        warmCallBenchmark(p.url, reqBody, timeoutMs),
        warmCallSlot(p.url, slotBody).catch(() => null),
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
        // Host-only label — never the full URL, which can embed an API key.
        endpoint_used: redactEndpointUrl(p.url),
        cold,
        warm,
      };
    }),
  );

  return { results, provider_tip_slots };
}
