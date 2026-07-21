/**
 * Parity tests: the env-var key lists that live OUTSIDE TypeScript (terraform
 * HCL, the seed-secrets.sh bash filter, the CDK secret template) must match the
 * single-source constants in env-keys.ts. TS consumers (CDK util.ts, CF
 * index.ts) import the constants directly and so can't drift; these files can't
 * import, so CI guards them here. A mismatch means a provider add/rename would
 * silently produce a cloud with zero samples — fail loudly instead.
 *
 * Comparisons are order-independent (set equality): terraform `toset`, the CDK
 * template object, and the bash array all have their own ordering.
 *
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_SECRET_KEYS, AWS_ENV_KEYS } from "./env-keys.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const assertSameSet = (actual: string[], expected: readonly string[], msg: string) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), msg);

/** Extract the quoted string entries inside a `name = [ ... ]` / `name = ([ ... ])` block. */
function keysInBlock(source: string, blockStart: RegExp): string[] {
  const from = source.search(blockStart);
  assert.ok(from >= 0, `block not found: ${blockStart}`);
  const rest = source.slice(from);
  const close = rest.indexOf("]");
  assert.ok(close >= 0, `unterminated block: ${blockStart}`);
  return Array.from(rest.slice(0, close).matchAll(/["']([A-Z0-9_]+)["']/g), (m) => m[1]!);
}

test("terraform local.secret_keys == WORKER_SECRET_KEYS", () => {
  const tf = read("infra/gcp/terraform/main.tf");
  const keys = keysInBlock(tf, /secret_keys\s*=\s*toset\(\[/);
  assertSameSet(keys, WORKER_SECRET_KEYS, "terraform local.secret_keys drifted from WORKER_SECRET_KEYS");
});

test("seed-secrets.sh WORKER_SECRETS == WORKER_SECRET_KEYS", () => {
  const sh = read("infra/gcp/seed-secrets.sh");
  const from = sh.search(/WORKER_SECRETS=\(/);
  assert.ok(from >= 0, "WORKER_SECRETS array not found in seed-secrets.sh");
  const close = sh.indexOf(")", from);
  const keys = Array.from(
    sh.slice(from, close).matchAll(/^\s*([A-Z0-9_]+)\s*$/gm),
    (m) => m[1]!,
  );
  assertSameSet(keys, WORKER_SECRET_KEYS, "seed-secrets.sh WORKER_SECRETS drifted from WORKER_SECRET_KEYS");
});

test("CDK secretStringTemplate keys ∪ generateStringKey == AWS_ENV_KEYS", () => {
  const cdk = read("infra/cdk/lib/secrets-stack.ts");
  // Template keys: `KEY: "..."` inside the JSON.stringify({ ... }) object.
  const templateKeys = keysInTemplate(cdk);
  // GENERATOR_SECRET is added via generateStringKey, not the template.
  const genMatch = cdk.match(/generateStringKey:\s*["']([A-Z0-9_]+)["']/);
  assert.ok(genMatch, "generateStringKey not found in secrets-stack.ts");
  const all = [...templateKeys, genMatch[1]!];
  assertSameSet(all, AWS_ENV_KEYS, "CDK secret key set drifted from AWS_ENV_KEYS");
});

/** Keys inside `secretStringTemplate: JSON.stringify({ ... })`. */
function keysInTemplate(source: string): string[] {
  const from = source.search(/secretStringTemplate:\s*JSON\.stringify\(\{/);
  assert.ok(from >= 0, "secretStringTemplate not found");
  const rest = source.slice(from);
  const close = rest.indexOf("})");
  assert.ok(close >= 0, "unterminated secretStringTemplate");
  // Match object keys `KEY:` (uppercase env-var style), ignoring commented lines.
  return Array.from(rest.slice(0, close).matchAll(/^\s*([A-Z0-9_]+):/gm), (m) => m[1]!);
}
