/**
 * seed-ops.ts — mirror local DEPLOY config into the AWS Secrets Manager blob
 * `rpcbench/ops` (the ops-side analogue of seed-aws.ts, which owns `rpcbench/env`).
 *
 * `rpcbench/ops` holds account-specific-but-not-secret deploy config — the CF
 * account id, GCP project id, workers.dev subdomain, and the TeraSwitch host
 * inventory — so a teammate with AWS access is provisioned for all four clouds
 * from one `aws sso login` (infra/scripts/bootstrap.sh pulls it back). Kept
 * separate from the app-secrets blob so the two concerns don't mix.
 *
 * Sources (operator-local, all gitignored):
 *   - scalar OPS keys (CLOUDFLARE_ACCOUNT_ID, PROJECT_ID, WORKERS_DEV_SUBDOMAIN)
 *     from `.ops.env` at the repo root (or the real environment).
 *   - TSW_HOSTS from the bash-array file `infra/bare-metal/hosts.env`, encoded
 *     as a JSON array of "IP REGION EGRESS" strings (bootstrap.sh expands it
 *     back into the bash-array form — see the round-trip contract below).
 *
 * The blob is MERGED onto the existing secret, so a key unset locally is
 * preserved rather than blanked. Secret string goes to the CLI via a 0600 temp
 * file (`file://`), never argv — matching seed-aws.ts / seed-secrets.sh.
 *
 * Run via the db workspace so `@rpcbench/shared` resolves. Root: `pnpm seed:ops`.
 * Operator-only — outsiders never need this.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, OPS_KEYS } from "@rpcbench/shared";

const AWS_SECRET_ID = "rpcbench/ops";
const REGION = process.env.AWS_REGION ?? "us-east-2";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OPS_ENV_FILE = join(REPO_ROOT, ".ops.env");
const HOSTS_FILE = join(REPO_ROOT, "infra/bare-metal/hosts.env");

function awsArgs(...args: string[]): string[] {
  const out = [...args, "--region", REGION];
  if (process.env.AWS_PROFILE) out.push("--profile", process.env.AWS_PROFILE);
  return out;
}

/**
 * Merge `.ops.env` (flat KEY=VAL, #-comments allowed) into process.env with the
 * same precedence as loadEnv: a value already in the real environment wins.
 */
function loadOpsEnv(): void {
  let text: string;
  try {
    text = readFileSync(OPS_ENV_FILE, "utf8");
  } catch {
    return; // no .ops.env — scalars come from the environment (or stay unset)
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of surrounding quotes (matches loadEnv).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Parse the bash-array `hosts.env` into a JSON array string of the quoted
 * triples, verbatim (inner whitespace preserved). Returns undefined if the file
 * is absent or defines no hosts, so TSW_HOSTS is then left unchanged in the blob.
 *
 * Round-trip contract (kept in lockstep with bootstrap.sh):
 *   disk:  TSW_HOSTS=(\n  "IP REGION EGRESS"\n  …\n)
 *   blob:  TSW_HOSTS = JSON.stringify(["IP REGION EGRESS", …])
 */
function tswHostsAsJson(): string | undefined {
  let text: string;
  try {
    text = readFileSync(HOSTS_FILE, "utf8");
  } catch {
    return undefined;
  }
  const open = text.search(/TSW_HOSTS=\(/);
  if (open < 0) return undefined;
  const close = text.indexOf(")", open);
  if (close < 0) return undefined;
  const body = text.slice(open, close);
  const entries = Array.from(body.matchAll(/"([^"]*)"/g), (m) => m[1]!);
  if (entries.length === 0) return undefined;
  return JSON.stringify(entries);
}

loadEnv(import.meta.url);
loadOpsEnv();

// Merge onto the current blob so a partial local config doesn't clobber values
// already in Secrets Manager.
let current: Record<string, string> = {};
try {
  const json = execFileSync(
    "aws",
    awsArgs(
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      AWS_SECRET_ID,
      "--query",
      "SecretString",
      "--output",
      "text",
    ),
    { encoding: "utf8" },
  );
  current = JSON.parse(json) as Record<string, string>;
} catch {
  console.warn("[seed-ops] could not read existing secret (first seed?) — writing a fresh blob.");
}

const blob: Record<string, string> = { ...current };
const set: string[] = [];
const skipped: string[] = [];
for (const key of OPS_KEYS) {
  const value = key === "TSW_HOSTS" ? tswHostsAsJson() : process.env[key];
  if (value === undefined || value === "") {
    skipped.push(key);
    continue;
  }
  blob[key] = value;
  set.push(key);
}

if (set.length === 0) {
  console.error(
    "[seed-ops] nothing to write — set CLOUDFLARE_ACCOUNT_ID / PROJECT_ID / " +
      "WORKERS_DEV_SUBDOMAIN in .ops.env and/or populate infra/bare-metal/hosts.env.",
  );
  process.exit(1);
}

// Hand the JSON to the CLI via a 0600 temp file, not argv (avoids leaking into
// the process table). Cleaned up in finally.
const tmpFile = join(tmpdir(), `rpcbench-seed-ops-${process.pid}.json`);
writeFileSync(tmpFile, JSON.stringify(blob), { mode: 0o600 });
try {
  // Unlike rpcbench/env (created by the CDK secrets stack), rpcbench/ops has no
  // provisioning stack — so create it on first seed, then put-value thereafter.
  const exists = (() => {
    try {
      execFileSync(
        "aws",
        awsArgs("secretsmanager", "describe-secret", "--secret-id", AWS_SECRET_ID),
        { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
      );
      return true;
    } catch {
      return false;
    }
  })();

  execFileSync(
    "aws",
    exists
      ? awsArgs(
          "secretsmanager",
          "put-secret-value",
          "--secret-id",
          AWS_SECRET_ID,
          "--secret-string",
          `file://${tmpFile}`,
        )
      : awsArgs(
          "secretsmanager",
          "create-secret",
          "--name",
          AWS_SECRET_ID,
          "--description",
          "rpc-perf-dash deploy config (CF/GCP ids, TSW inventory) — seeded by seed-ops.ts",
          "--secret-string",
          `file://${tmpFile}`,
        ),
    { encoding: "utf8" },
  );
  if (!exists) console.log(`[seed-ops] created secret ${AWS_SECRET_ID} (first seed).`);
} finally {
  unlinkSync(tmpFile);
}

console.log(`[seed-ops] updated ${set.length} key(s) in ${AWS_SECRET_ID}: ${set.join(", ")}`);
if (skipped.length > 0) {
  console.warn(`[seed-ops] left unchanged (unset locally): ${skipped.join(", ")}`);
}
