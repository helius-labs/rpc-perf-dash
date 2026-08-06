/**
 * SendTarget trait + adapter factory (port of `send_target.rs`).
 *
 * A SendTarget takes a signed, base64 wire transaction and submits it, throwing
 * on a submit-side failure (non-2xx, JSON-RPC error, network). The dispatcher
 * records submit latency and, on throw, classifies the row `submit_error`.
 *
 * Every target speaks plain JSON-RPC `sendTransaction` on the provider's
 * standard read endpoint — one adapter (`JsonRpcSendTarget`) covers all five.
 */

import type { SendTargetConfig, SendTargetId, SendTip } from "@rpcbench/shared";
import { applyRegion } from "../region.js";
import { resolveEnvValue, resolveEnvMap, withQueries } from "../util.js";
import { JsonRpcSendTarget } from "./jsonRpc.js";

export interface SendTarget {
  readonly name: SendTargetId;
  /** The tip this path expects (directed to its own account), if any. */
  readonly tip?: SendTip | undefined;
  /** Submit a base64 wire tx. Resolves on ack; throws on submit failure. */
  send(base64Tx: string): Promise<void>;
}

/** A resolved, ready-to-send target (all env vars present, region filled). */
export interface ResolvedTargetConfig {
  name: SendTargetId;
  url: string;
  headers: Record<string, string>;
  protocol: "jsonrpc";
  tip?: SendTip | undefined;
}

/**
 * Resolve a `SendTargetConfig` for a given worker region: fill `{region}`,
 * resolve `env:` in url/headers/queries. Returns null if any referenced env var
 * is missing (target not configured on this deployment — dispatcher skips it).
 */
export function resolveTargetConfig(
  cfg: SendTargetConfig,
  workerRegion: string,
): ResolvedTargetConfig | null {
  const rawUrl = resolveEnvValue(cfg.url);
  if (rawUrl === null) return null;
  const headers = resolveEnvMap(cfg.headers);
  if (headers === null) return null;
  const queries = resolveEnvMap(cfg.queries);
  if (queries === null) return null;

  const url = applyRegion(rawUrl, cfg.name, workerRegion);
  const finalUrl = withQueries(url, queries);

  return { name: cfg.name, url: finalUrl, headers, protocol: cfg.protocol, tip: cfg.tip };
}

/** Build the concrete SendTarget adapter for a resolved config (JSON-RPC only). */
export function createSendTarget(cfg: ResolvedTargetConfig, timeoutMs = 15_000): SendTarget {
  return new JsonRpcSendTarget(cfg, timeoutMs);
}
