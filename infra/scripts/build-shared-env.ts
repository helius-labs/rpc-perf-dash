/**
 * build-shared-env.ts — generate the worker shared-env file from local env.
 *
 * `/tmp/rpc-bench-worker.env.shared` is the flat KEY=VAL file that deploy-cf.sh
 * (→ `wrangler secret put`) and deploy-tsw.sh (→ /etc EnvironmentFile) feed to
 * their fleets. Historically it was rebuilt by hand from AWS Secrets Manager,
 * which outsiders (no AWS account) can't do. This builds it from `.env` /
 * `.env.local` — the SAME source the app reads via loadEnv — so anyone with a
 * filled-in local env can deploy without AWS.
 *
 * The key set is WORKER_SECRET_KEYS (derived from the provider registry in
 * packages/shared/src/env-keys.ts), so the shared file can never drift from
 * providers.ts.
 *
 * Run via the db workspace so `@rpcbench/shared` + loadEnv resolve (same as
 * verify-deploy.ts). The root `pnpm build:shared-env` script wires this up.
 *
 *   pnpm build:shared-env                    # from .env / .env.local (default)
 *   pnpm build:shared-env --from aws         # pull rpcbench/env instead (internal)
 *   pnpm build:shared-env --out /tmp/x.env   # custom output path
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadEnv, WORKER_SECRET_KEYS } from "@rpcbench/shared";

const DEFAULT_OUT = "/tmp/rpc-bench-worker.env.shared";
const AWS_SECRET_ID = "rpcbench/env";

function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Pull the canonical blob from AWS Secrets Manager (internal `--from aws` path). */
function valuesFromAws(): Record<string, string> {
  const args = [
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    AWS_SECRET_ID,
    "--region",
    process.env.AWS_REGION ?? "us-east-2",
    "--query",
    "SecretString",
    "--output",
    "text",
  ];
  if (process.env.AWS_PROFILE) args.push("--profile", process.env.AWS_PROFILE);
  return JSON.parse(execFileSync("aws", args, { encoding: "utf8" })) as Record<string, string>;
}

/** Read from .env / .env.local with the app's own precedence (loadEnv). */
function valuesFromLocalEnv(): Record<string, string> {
  loadEnv(import.meta.url);
  const out: Record<string, string> = {};
  for (const key of WORKER_SECRET_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const fromAws = flagValue("--from") === "aws";
const outPath = flagValue("--out") ?? DEFAULT_OUT;
const values = fromAws ? valuesFromAws() : valuesFromLocalEnv();

const lines: string[] = [];
const missing: string[] = [];
for (const key of WORKER_SECRET_KEYS) {
  const value = values[key];
  // Skip unset / placeholder values — a provider whose env is unset is silently
  // skipped at runtime (resolveEndpointUrl returns null), so don't emit a blank.
  if (value === undefined || value === "" || value === "TODO") {
    missing.push(key);
    continue;
  }
  lines.push(`${key}=${value}`);
}

writeFileSync(outPath, `${lines.join("\n")}\n`, { mode: 0o600 });

const source = fromAws ? "AWS rpcbench/env" : ".env / .env.local";
console.log(`[build-shared-env] wrote ${lines.length} key(s) -> ${outPath} (source: ${source})`);
if (missing.length > 0) {
  console.warn(
    `[build-shared-env] WARN: ${missing.length} unset key(s) skipped: ${missing.join(", ")} — ` +
      `that DB/provider will not be benchmarked on the deployed fleets.`,
  );
}
