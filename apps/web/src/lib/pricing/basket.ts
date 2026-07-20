/**
 * Client-safe Basket <-> URL codec for the /costs page. Mirrors the validate-
 * on-parse pattern in lib/challengeFilters.ts so SSR and the client island
 * decode identically, and every basket is a shareable/bookmarkable URL.
 *
 * Query scheme (all params optional, order-independent):
 *   m=getProgramAccounts:1000000,getAccountInfo:5000000   methods + monthly call counts
 *   stream=geyser;gb=100,websocket;msgs=2000000           streaming usage per kind
 *   plan=helius:helius_business,quicknode:...   per-provider plan pins
 *   preset=frontend&calls=10000000                         seed from a workload profile when m= absent
 *   peak=3                                                 peak-to-average burst factor for the rate check
 */

import type { Method } from "@rpcbench/shared";
import { ALL_METHODS } from "../methods";
import type { Basket, StreamKind, StreamingUsage } from "./types";
import { basketFromProfile } from "./presets";

export const MAX_CALLS_PER_METHOD = 1_000_000_000_000; // 1T — well above any real monthly volume
export const MAX_STREAM_VALUE = 1_000_000_000_000;
export const MAX_PEAK_MULTIPLIER = 1000;
export const MAX_BYTES_PER_CALL = 100_000_000; // 100 MB/call — above any realistic single response

const METHOD_SET = new Set<string>(ALL_METHODS as readonly string[]);
const STREAM_KINDS: readonly StreamKind[] = ["websocket", "laserstream", "geyser", "webhook"];
const STREAM_KIND_SET = new Set<string>(STREAM_KINDS);

const VALID_PROVIDER_IDS = new Set(["helius", "triton", "alchemy", "quicknode"]);

function clampNum(raw: string | undefined, max: number): number {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.floor(n));
}

type ParamMap = Partial<
  Record<"m" | "stream" | "plan" | "preset" | "calls" | "peak" | "bytes", string | undefined>
>;

/** Parse a peak multiplier, clamped to [1, MAX_PEAK_MULTIPLIER]; null if absent/invalid. */
function parsePeak(raw: string | undefined): number | null {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(MAX_PEAK_MULTIPLIER, n);
}

export function parseBasket(params: ParamMap): Basket {
  // Methods
  const methods: Partial<Record<Method, number>> = {};
  if (params.m) {
    for (const entry of params.m.split(",")) {
      const [name, countRaw] = entry.split(":");
      if (!name || !METHOD_SET.has(name)) continue;
      const count = clampNum(countRaw, MAX_CALLS_PER_METHOD);
      if (count > 0) methods[name as Method] = count;
    }
  }

  // Preset seeding when no explicit methods were given.
  if (Object.keys(methods).length === 0 && params.preset) {
    const calls = clampNum(params.calls, MAX_CALLS_PER_METHOD);
    const seeded = basketFromProfile(params.preset, calls > 0 ? calls : 10_000_000);
    Object.assign(methods, seeded.methods);
  }

  // Streaming
  const streaming: StreamingUsage[] = [];
  if (params.stream) {
    for (const entry of params.stream.split(",")) {
      const fields = entry.split(";");
      const kind = fields[0];
      if (!kind || !STREAM_KIND_SET.has(kind)) continue;
      const usage: StreamingUsage = { kind: kind as StreamKind };
      for (const f of fields.slice(1)) {
        const [k, v] = f.split("=");
        if (k === "gb") usage.gbPerMonth = clampNum(v, MAX_STREAM_VALUE);
        else if (k === "msgs") usage.messagesPerMonth = clampNum(v, MAX_STREAM_VALUE);
        else if (k === "secs") usage.connectionSeconds = clampNum(v, MAX_STREAM_VALUE);
        else if (k === "conc") usage.concurrentSubscriptions = clampNum(v, MAX_STREAM_VALUE);
      }
      streaming.push(usage);
    }
  }

  // Plan overrides
  let planOverrides: Record<string, string> | undefined;
  if (params.plan) {
    const overrides: Record<string, string> = {};
    for (const entry of params.plan.split(",")) {
      const [providerId, planId] = entry.split(":");
      if (providerId && planId && VALID_PROVIDER_IDS.has(providerId)) {
        overrides[providerId] = planId;
      }
    }
    if (Object.keys(overrides).length > 0) planOverrides = overrides;
  }

  const basket: Basket = { methods, streaming };
  if (planOverrides) basket.planOverrides = planOverrides;
  const peak = parsePeak(params.peak);
  if (peak != null) basket.peakMultiplier = peak;
  const bytes = clampNum(params.bytes, MAX_BYTES_PER_CALL);
  if (bytes > 0) basket.rpcBytesPerCall = bytes;
  return basket;
}

/** Encode a basket into a query string (no leading "?"). Empty when nothing set. */
export function encodeBasket(basket: Basket): string {
  const parts: string[] = [];

  const m = Object.entries(basket.methods)
    .filter(([, c]) => (c ?? 0) > 0)
    .map(([name, c]) => `${name}:${c}`)
    .join(",");
  if (m) parts.push(`m=${m}`);

  const stream = basket.streaming
    .map((u) => {
      const fields: string[] = [u.kind];
      if (u.gbPerMonth) fields.push(`gb=${u.gbPerMonth}`);
      if (u.messagesPerMonth) fields.push(`msgs=${u.messagesPerMonth}`);
      if (u.connectionSeconds) fields.push(`secs=${u.connectionSeconds}`);
      if (u.concurrentSubscriptions) fields.push(`conc=${u.concurrentSubscriptions}`);
      return fields.length > 1 ? fields.join(";") : "";
    })
    .filter(Boolean)
    .join(",");
  if (stream) parts.push(`stream=${stream}`);

  if (basket.planOverrides) {
    const plan = Object.entries(basket.planOverrides)
      .map(([pid, plid]) => `${pid}:${plid}`)
      .join(",");
    if (plan) parts.push(`plan=${plan}`);
  }

  if (basket.peakMultiplier != null && basket.peakMultiplier !== 1) {
    parts.push(`peak=${basket.peakMultiplier}`);
  }

  if (basket.rpcBytesPerCall != null && basket.rpcBytesPerCall > 0) {
    parts.push(`bytes=${basket.rpcBytesPerCall}`);
  }

  return parts.join("&");
}
