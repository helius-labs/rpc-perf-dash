/**
 * JSON-RPC `sendTransaction` adapter (Helius Sender + JSON-RPC relays).
 * base64 encoding, skipPreflight, maxRetries:0. Throws on non-2xx, invalid
 * JSON, or a JSON-RPC `error` field.
 */

import type { SendTargetId, SendTip } from "@rpcbench/shared";
import type { ResolvedTargetConfig, SendTarget } from "./index.js";

export class JsonRpcSendTarget implements SendTarget {
  readonly name: SendTargetId;
  readonly tip?: SendTip | undefined;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(cfg: ResolvedTargetConfig, timeoutMs: number) {
    this.name = cfg.name;
    this.tip = cfg.tip;
    this.url = cfg.url;
    this.headers = cfg.headers;
    this.timeoutMs = timeoutMs;
  }

  async send(base64Tx: string): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`${this.name}: HTTP ${res.status} ${await safeText(res)}`);
    }
    const json = (await res.json()) as { error?: unknown; result?: string };
    if (json.error) {
      throw new Error(`${this.name}: JSON-RPC error ${JSON.stringify(json.error)}`);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
