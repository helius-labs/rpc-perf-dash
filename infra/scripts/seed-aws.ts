/**
 * seed-aws.ts — mirror local env into the canonical AWS Secrets Manager blob.
 *
 * Reverses the historical flow: `.env` / `.env.local` is now the source of
 * truth, and this pushes it into `rpcbench/env` so the internal AWS/ECS deploy
 * path (task defs read the secret directly) and the `build-shared-env --from
 * aws` rebuild keep working. Outsiders never need this — it's operator-only.
 *
 * Writes the AWS_ENV_KEYS set (worker secrets + generator-only keys: direct DB
 * URL, utility endpoint, commit-reveal secret). The blob is MERGED onto the
 * existing secret, so keys absent from local env are preserved rather than
 * blanked. Secret values go to the CLI via a 0600 temp file (`file://`), never
 * argv — matching seed-secrets.sh's care about not leaking into `ps`.
 *
 * Run via the db workspace so `@rpcbench/shared` + loadEnv resolve. The root
 * `pnpm seed:aws` script wires this up.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, AWS_ENV_KEYS } from "@rpcbench/shared";

const AWS_SECRET_ID = "rpcbench/env";
const REGION = process.env.AWS_REGION ?? "us-east-2";

function awsArgs(...args: string[]): string[] {
  const out = [...args, "--region", REGION];
  if (process.env.AWS_PROFILE) out.push("--profile", process.env.AWS_PROFILE);
  return out;
}

loadEnv(import.meta.url);

// Merge onto the current blob so a partial local env doesn't clobber values
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
  console.warn("[seed-aws] could not read existing secret (first seed?) — writing a fresh blob.");
}

const blob: Record<string, string> = { ...current };
const set: string[] = [];
const skipped: string[] = [];
for (const key of AWS_ENV_KEYS) {
  const value = process.env[key];
  if (value === undefined || value === "") {
    skipped.push(key);
    continue;
  }
  blob[key] = value;
  set.push(key);
}

// Hand the JSON to the CLI via a 0600 temp file, not argv (avoids leaking
// secrets into the process table). Cleaned up in finally.
const tmpFile = join(tmpdir(), `rpcbench-seed-${process.pid}.json`);
writeFileSync(tmpFile, JSON.stringify(blob), { mode: 0o600 });
try {
  execFileSync(
    "aws",
    awsArgs(
      "secretsmanager",
      "put-secret-value",
      "--secret-id",
      AWS_SECRET_ID,
      "--secret-string",
      `file://${tmpFile}`,
    ),
    { encoding: "utf8" },
  );
} finally {
  unlinkSync(tmpFile);
}

console.log(`[seed-aws] updated ${set.length} key(s) in ${AWS_SECRET_ID}: ${set.join(", ")}`);
if (skipped.length > 0) {
  console.warn(`[seed-aws] left unchanged (unset in local env): ${skipped.join(", ")}`);
}
