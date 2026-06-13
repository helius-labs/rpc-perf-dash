/**
 * Multi-endpoint utility-RPC client with per-endpoint health tracking and
 * a circuit-breaker, so the generator survives a single upstream going
 * 403/5xx/dead.
 *
 * Background — 2026-05-24 outage:
 *   The generator used a single `createRpcClient(env:UTILITY_RPC_URL)` and the
 *   SlotObserver's `.catch(() => {})` ate every error. When Chainstack
 *   started returning HTTP 403 for our key, slot polling silently froze;
 *   `deriveChallenge` couldn't build any challenges (no slots in
 *   `recentSlots`); the whole fleet went 2 days without producing a sample.
 *
 * Design:
 *   - Takes a list of endpoint URLs in priority order. Skips falsy/unset.
 *   - Each call() iterates from the highest-priority closed endpoint and
 *     falls through on failure. Open endpoints (circuit broken) are
 *     skipped until their cooldown elapses, then probed once (half-open).
 *   - Per-endpoint stats — last_ok_at, last_err_at, last_err_msg,
 *     consec_fails, circuit_state — are exposed via getStatus() so the
 *     generator can persist them to the `utility_rpc_status` table and the
 *     dashboard can render them.
 *
 * NOT a generic provider client: scoped to the generator's utility role
 * (SlotObserver getSlot + honeypot derivation + benchmark.ts pre-flight).
 * The quorum and worker code paths keep their existing per-call clients.
 */

import type { RpcCallOptions, RpcClient } from "@rpcbench/shared";
import { createRpcClient } from "./rpc.js";

const FAILS_TO_OPEN = 5;
const OPEN_COOLDOWN_MS = 30_000;

export type CircuitState = "closed" | "open" | "half-open";

export interface EndpointStatus {
  endpoint_index: number;
  url_label: string;
  last_ok_at: Date | null;
  last_err_at: Date | null;
  last_err_msg: string | null;
  consec_fails: number;
  circuit_state: CircuitState;
}

interface EndpointSlot {
  index: number;
  /** "{ENV_VAR_NAME} · {hostname}" — never includes the raw URL or secrets. */
  url_label: string;
  client: RpcClient;
  last_ok_at: Date | null;
  last_err_at: Date | null;
  last_err_msg: string | null;
  consec_fails: number;
  /** Wall-clock ms at which an open endpoint becomes half-open (one probe). */
  open_until_ms: number;
}

export interface MultiEndpointRpcClient extends RpcClient {
  /** Snapshot every endpoint's current health state. */
  getStatus(): readonly EndpointStatus[];
}

export interface UtilityEndpointSpec {
  /** Env var name the URL was resolved from (used for the label only). */
  env_var: string;
  url: string;
}

/**
 * Build the multi-endpoint client.
 *
 * `specs` is filtered to defined entries by the caller — the constructor
 * does not look at process.env.
 */
export function createUtilityClient(
  specs: readonly UtilityEndpointSpec[],
  timeoutMs = 5000,
): MultiEndpointRpcClient {
  if (specs.length === 0) {
    throw new Error("createUtilityClient: at least one endpoint URL is required");
  }

  const slots: EndpointSlot[] = specs.map((s, i) => ({
    index: i,
    url_label: labelFor(s),
    client: createRpcClient(s.url, timeoutMs),
    last_ok_at: null,
    last_err_at: null,
    last_err_msg: null,
    consec_fails: 0,
    open_until_ms: 0,
  }));

  function circuitState(slot: EndpointSlot, now: number): CircuitState {
    if (slot.consec_fails < FAILS_TO_OPEN) return "closed";
    if (now >= slot.open_until_ms) return "half-open";
    return "open";
  }

  function recordOk(slot: EndpointSlot, now: number): void {
    slot.last_ok_at = new Date(now);
    slot.last_err_msg = null;
    slot.consec_fails = 0;
    slot.open_until_ms = 0;
  }

  function recordErr(slot: EndpointSlot, err: unknown, now: number): void {
    slot.last_err_at = new Date(now);
    slot.last_err_msg = errMessage(err);
    slot.consec_fails += 1;
    if (slot.consec_fails >= FAILS_TO_OPEN) {
      slot.open_until_ms = now + OPEN_COOLDOWN_MS;
    }
  }

  async function call<T>(method: string, params: unknown[], opts?: RpcCallOptions): Promise<T> {
    const now = Date.now();
    // Try closed endpoints first, then half-open (the probe), then nothing.
    const order = [
      ...slots.filter((s) => circuitState(s, now) === "closed"),
      ...slots.filter((s) => circuitState(s, now) === "half-open"),
    ];
    // If every endpoint is open and none are due for probe yet, force-pick
    // the one closest to recovery so requests don't completely starve.
    if (order.length === 0) {
      const next = [...slots].sort((a, b) => a.open_until_ms - b.open_until_ms)[0]!;
      order.push(next);
    }

    let lastErr: unknown = null;
    for (const slot of order) {
      try {
        const out = await slot.client.call<T>(method, params, opts);
        recordOk(slot, Date.now());
        return out;
      } catch (err) {
        recordErr(slot, err, Date.now());
        lastErr = err;
        // Try next endpoint.
      }
    }
    throw lastErr ?? new Error("all utility endpoints failed");
  }

  function getStatus(): readonly EndpointStatus[] {
    const now = Date.now();
    return slots.map((s) => ({
      endpoint_index: s.index,
      url_label: s.url_label,
      last_ok_at: s.last_ok_at,
      last_err_at: s.last_err_at,
      last_err_msg: s.last_err_msg,
      consec_fails: s.consec_fails,
      circuit_state: circuitState(s, now),
    }));
  }

  return { call, getStatus };
}

function labelFor(spec: UtilityEndpointSpec): string {
  let host = "?";
  try {
    host = new URL(spec.url).host;
  } catch {
    // ignore — keep "?"
  }
  return `${spec.env_var} · ${host}`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
