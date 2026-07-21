/** Minimal JSON-RPC client used by generator (preflight + slot observation). */
import type { RpcCallOptions, RpcClient } from "@rpcbench/shared";

export function createRpcClient(url: string, timeoutMs = 5000): RpcClient {
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[], opts?: RpcCallOptions): Promise<T> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: ctrl.signal,
        });
        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new Error(`${method}: ${json.error.message}`);
        return json.result as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
