/**
 * CommonJS boot wrapper. Binds port 8080 IMMEDIATELY with zero imports
 * beyond Node built-ins, then spawns the real tsx-driven worker as a
 * subprocess.
 *
 * Background — Cloudflare Containers gives ~20s for the container to bind
 * its declared port (TIMEOUT_TO_GET_PORTS in @cloudflare/containers SDK).
 * Our worker normally invokes tsx which type-strips 15+ ESM files
 * (drizzle, postgres, undici, …) before reaching its http listener. On
 * cold firecracker starts that exceeded the budget and CF gave up,
 * marking the container crashed with zero stdout in wrangler tail.
 *
 * Plain `require()` of `node:http` is millisecond-fast, so this file
 * binds the port within ~50ms of process start regardless of how slow
 * the rest of the worker takes to come up. The listener also exposes
 * worker subprocess state (pid, exit code) so the JSON response
 * reflects actual liveness.
 *
 * Used as the container CMD on Cloudflare (via Container.entrypoint).
 * On AWS/TSW the original `pnpm start` path still works fine because
 * they don't have the 20s startup window — but for parity we could
 * eventually switch everywhere.
 */

const http = require("node:http");
const { spawn } = require("node:child_process");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

const state = {
  phase: "starting",
  worker_pid: null,
  worker_exit_code: null,
  worker_signal: null,
  boot_at: new Date().toISOString(),
  // Rolling 200-line buffer of subprocess stdout+stderr so the /healthcheck
  // endpoint surfaces what tsx actually printed before dying. CF Containers
  // doesn't expose container stdout via wrangler tail, so this is our only
  // observability into the subprocess.
  //
  // The healthcheck is internet-reachable (the CF Worker proxies any inbound
  // request to the container), so two safeguards apply:
  //   1. Lines are scrubbed at capture time — any occurrence of a
  //      secret-bearing env VALUE (DB URLs, provider URLs with embedded
  //      keys) is replaced before it enters the buffer.
  //   2. recent_output is only included in the response after the worker
  //      has died (its actual purpose: boot/crash diagnosis). Healthy
  //      workers prove liveness via DB heartbeats; their logs stay private.
  recent_output: [],
};

// Secret-bearing env values to scrub from captured lines. Provider URLs can
// embed keys in the PATH (QuickNode/Alchemy style), so value-based matching
// is required — `api-key=` pattern regexes alone would miss them. Unset/empty
// vars are skipped (the CF container env carries only a subset of these).
const SECRET_ENV_VARS = [
  "NEON_DATABASE_URL_POOLED",
  "HELIUS_URL",
  "TRITON_URL",
  "ALCHEMY_URL",
  "QUICKNODE_URL",
  "UTILITY_RPC_URL",
  "GENERATOR_SECRET",
];
// Minimum value length to scrub: a too-short "secret" (a single character,
// say) would shred every log line and, worse, could recur inside its own
// `[redacted:…]` replacement. Real DB URLs / API keys are far longer.
const SECRET_VALUES = SECRET_ENV_VARS
  .map((name) => ({ name, value: process.env[name] }))
  .filter((s) => typeof s.value === "string" && s.value.length >= 8);

function scrub(line) {
  let out = line;
  for (const { name, value } of SECRET_VALUES) {
    // split/join replaces every occurrence in one pass — no re-scan of the
    // replacement text, so a value that overlaps "[redacted:…]" can't loop.
    if (out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
  }
  // Backstop for partial-URL fragments that don't contain a full env value.
  out = out.replace(/(api-?key=)[^&\s"']+/gi, "$1[redacted]");
  out = out.replace(/(:\/\/)[^/\s"']*:[^@/\s"']*@/g, "$1[redacted]@");
  return out;
}

function recordLine(stream, chunk) {
  const text = chunk.toString();
  process[stream].write(text);
  for (const line of text.split("\n")) {
    if (line) {
      state.recent_output.push(scrub(`[${stream}] ${line}`));
      if (state.recent_output.length > 200) state.recent_output.shift();
    }
  }
}

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  // Expose the output buffer only once the worker is dead — the healthcheck
  // is public, and crash diagnosis is the buffer's only audience.
  const { recent_output, ...publicState } = state;
  const workerDead =
    state.phase === "worker_exited" || state.phase === "worker_spawn_error";
  res.end(
    JSON.stringify({
      ...publicState,
      ...(workerDead ? { recent_output } : {}),
      uptime_s: Math.round(process.uptime()),
      path: req.url,
    }),
  );
});

server.on("error", (err) => {
  process.stderr.write(`[boot] http error: ${err.message}\n`);
});

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`[boot] listening on 0.0.0.0:${PORT}\n`);
  state.phase = "spawning_worker";
  spawnWorker();
});

function spawnWorker() {
  process.stderr.write(`[boot] spawning tsx /repo/apps/worker/src/index.ts\n`);
  const child = spawn(
    "/repo/node_modules/.bin/tsx",
    ["/repo/apps/worker/src/index.ts"],
    {
      // Pipe both stdout and stderr so we can capture them into recent_output.
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  state.worker_pid = child.pid;
  state.phase = "worker_running";
  process.stderr.write(`[boot] spawned worker pid=${child.pid}\n`);

  child.stdout.on("data", (c) => recordLine("stdout", c));
  child.stderr.on("data", (c) => recordLine("stderr", c));

  child.on("error", (err) => {
    state.phase = "worker_spawn_error";
    recordLine("stderr", `[boot] spawn error: ${err.message}\n`);
  });

  child.on("exit", (code, signal) => {
    state.worker_exit_code = code;
    state.worker_signal = signal;
    state.phase = `worker_exited`;
    process.stderr.write(`[boot] worker exited code=${code} signal=${signal}\n`);
    // DO NOT exit boot.cjs. Keep the HTTP listener alive so the
    // /healthcheck JSON surfaces the exit code + recent_output. CF will
    // serve 200s pointing at a dead worker, but at least we get
    // visibility instead of an opaque container-restart loop.
  });
}
