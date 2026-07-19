/**
 * Minimal Worker that wraps the rpc-perf-dash worker container.
 *
 * The Worker exists because Cloudflare Containers requires a Worker entry
 * point that dispatches HTTP traffic to the container. We don't use the
 * Worker for any application logic — the actual benchmark work runs inside
 * the container on its own polling loop. The Worker just keeps the container
 * "warm" and proxies healthcheck pings to the container's :8080 HTTP server.
 *
 * The container is a singleton instance (one always-on copy). `sleepAfter`
 * is set generously so CF doesn't tear it down between healthchecks.
 */

import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  WORKER_CONTAINER: DurableObjectNamespace<WorkerContainer>;
  // Plain vars from wrangler.jsonc + secrets from `wrangler secret put`.
  // Forwarded into the container via this.envVars in the constructor below.
  WORKER_PROVIDER: string;
  WORKER_REGION: string;
  WORKER_EGRESS_PATH: string;
  PORT: string;
  // Workers open a pooled connection only, so only the pooled URL is bound.
  NEON_DATABASE_URL_POOLED: string;
  HELIUS_URL: string;
  TRITON_URL: string;
  ALCHEMY_URL: string;
  QUICKNODE_URL: string;
}

export class WorkerContainer extends Container<Env> {
  defaultPort = 8080;
  // Stay running for benchmarking even when no HTTP traffic — the container
  // runs its own polling loop independent of requests. The parser only
  // accepts singular + short units ("24h", "1d"); "30 days" throws.
  sleepAfter = "24h";
  // Plain-Node boot wrapper that binds port 8080 in ~50ms (just node:http
  // require, no tsx, no workspace imports), then spawns tsx + the real
  // worker as a subprocess. Beats CF's 20s port-check window even on the
  // slowest firecracker cold start. See apps/worker/boot.cjs for details.
  entrypoint = ["/usr/local/bin/node", "/repo/apps/worker/boot.cjs"];
  enableInternet = true;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Worker secrets DON'T auto-propagate into the container. Without this
    // the container boots without NEON_DATABASE_URL_*, createDb() throws,
    // Node exits, port 8080 never binds, CF reports "container not listening
    // in TCP address 10.0.0.1:8080".
    this.envVars = {
      WORKER_PROVIDER: env.WORKER_PROVIDER,
      WORKER_REGION: env.WORKER_REGION,
      WORKER_EGRESS_PATH: env.WORKER_EGRESS_PATH,
      PORT: env.PORT,
      NEON_DATABASE_URL_POOLED: env.NEON_DATABASE_URL_POOLED,
      HELIUS_URL: env.HELIUS_URL,
      TRITON_URL: env.TRITON_URL,
      ALCHEMY_URL: env.ALCHEMY_URL,
      QUICKNODE_URL: env.QUICKNODE_URL,
    };
  }
}

/**
 * Multi-lane CF deployment: N named container instances, each backed by its own
 * Durable Object, which CF's scheduler places at a PoP independently (they tend
 * to spread geographically). Each container reports its own PoP via cdn-cgi/trace
 * (apps/worker/src/index.ts:detectCfPop). Lane names are NOT geo hints — CF
 * ignores them; they only disambiguate DO instances. Keep the count matched to
 * max_instances in wrangler.jsonc.
 */
const LANES = ["cf1", "cf2", "cf3", "cf4", "cf5", "cf6"] as const;

function laneContainer(env: Env, lane: string) {
  return getContainer(env.WORKER_CONTAINER, lane);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route inbound traffic to a random lane so /healthcheck reaches whichever
    // container is responsive; each lane reports its own PoP in the JSON.
    const lane = LANES[Math.floor(Math.random() * LANES.length)]!;
    const c = laneContainer(env, lane);
    const res = await c.fetch(request);
    // Add a header so callers can see which lane served.
    const out = new Response(res.body, res);
    out.headers.set("x-cf-lane", lane);
    return out;
  },

  // Cron keep-alive: CF only counts inbound HTTP as "activity" for
  // sleepAfter. Internal Neon polling doesn't count. So fire a ping at
  // every lane on every cron tick to ensure they all stay warm.
  // Configured in wrangler.jsonc (every 6h).
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await Promise.all(
      LANES.map((lane) =>
        laneContainer(env, lane)
          .fetch("https://internal/keepalive")
          .catch((e) => {
            console.warn(`lane ${lane} keepalive failed: ${(e as Error).message}`);
          }),
      ),
    );
  },
};
