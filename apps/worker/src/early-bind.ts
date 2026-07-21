/**
 * Bind port 8080 immediately on module load, BEFORE any heavy imports.
 *
 * Cloudflare Containers gives the container ~20 seconds to bind its
 * declared port (see @cloudflare/containers TIMEOUT_TO_GET_PORTS). Our
 * worker normally does 15+ ESM imports (drizzle, postgres, undici,
 * tsx transformations) before reaching the http server inside main(),
 * which exceeds the budget on cold firecracker starts.
 *
 * This module exposes a mutable status object so the listener can
 * report progress (loading → ready → sampling) as the rest of the
 * worker boots up.
 *
 * Imported FIRST in index.ts. On AWS/TSW the listener binds and sits
 * idle — same behavior as the original startHealthServer().
 */

import { createServer } from "node:http";

interface Status {
  phase: "starting" | "loading" | "ready" | "sampling";
  worker_id: string | null;
  worker_provider: string | null;
  region: string | null;
  egress_path: string | null;
  last_sample_at: string | null;
  loaded_at: string | null;
}

export const status: Status = {
  phase: "starting",
  worker_id: null,
  worker_provider: null,
  region: null,
  egress_path: null,
  last_sample_at: null,
  loaded_at: null,
};

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const server = createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ...status,
      uptime_s: Math.round(process.uptime()),
      path: req.url,
    }),
  );
});

server.on("error", (err) => {
  // EADDRINUSE on AWS/TSW where another process owns the port is acceptable;
  // the worker itself doesn't depend on HTTP.
  process.stderr.write(`[early-bind] error: ${(err as Error).message}\n`);
});

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`[early-bind] listening on 0.0.0.0:${PORT}\n`);
});
