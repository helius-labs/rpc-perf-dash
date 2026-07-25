/**
 * Lightweight .env loader. Apps call `loadEnv()` at the very top of their
 * entry file (before any other import that reads process.env).
 *
 * Precedence (highest first): the real process environment (deployment env,
 * `KEY=val pnpm dev` overrides) > `.env.local` > `.env`. This matches the
 * universal dotenv convention that the more-local `.env.local` wins.
 *
 * A previous version loaded `.env` first and only set a key when unset, which
 * silently inverted this — `.env` beat `.env.local`. That shipped a stale
 * provider key to prod (a `.env.local` fix was shadowed by a wrong `.env`
 * value); see docs/operations.md. When both files define the same key with
 * DIFFERENT values, we now log a loud warning so that drift is visible.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Find the repo root by walking up looking for `pnpm-workspace.yaml`. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function parse(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load .env and .env.local from the repo root. Idempotent.
 * Pass `import.meta.url` so the resolver can locate the repo root regardless
 * of where the script was launched from.
 */
/**
 * Merge parsed env files (given in load order; a later file overrides an
 * earlier one) against the keys already present in the real environment (which
 * always win). Returns the values to apply and the keys that were defined in
 * more than one file with DIFFERENT values. Pure — exported for tests.
 */
export function mergeEnvFiles(
  realEnvKeys: ReadonlySet<string>,
  files: ReadonlyArray<Record<string, string>>,
): { values: Record<string, string>; conflicts: string[] } {
  const values: Record<string, string> = {};
  const conflicts = new Set<string>();
  for (const parsed of files) {
    for (const [k, v] of Object.entries(parsed)) {
      if (realEnvKeys.has(k)) continue; // real env wins over any file
      if (values[k] !== undefined && values[k] !== v) conflicts.add(k);
      values[k] = v; // later file overrides earlier → .env.local beats .env
    }
  }
  return { values, conflicts: [...conflicts] };
}

export function loadEnv(callerImportMetaUrl: string): void {
  const here = dirname(fileURLToPath(callerImportMetaUrl));
  const root = findRepoRoot(here);

  // Keys already present in the REAL environment before we touch any file must
  // always win (deployment env / inline overrides) — never overwrite them.
  const fromRealEnv = new Set(Object.keys(process.env));

  // Load `.env` first, then `.env.local`; the later file wins.
  const files: Record<string, string>[] = [];
  for (const file of [".env", ".env.local"]) {
    const path = resolve(root, file);
    if (existsSync(path)) files.push(parse(readFileSync(path, "utf8")));
  }

  const { values, conflicts } = mergeEnvFiles(fromRealEnv, files);
  for (const k of conflicts) {
    // Same key in both .env and .env.local with different values — the exact
    // footgun that shipped a wrong provider key. Make it loud.
    console.warn(
      `[loadEnv] WARN: ${k} defined in both .env and .env.local with ` +
        `different values — using the .env.local value. Reconcile them.`,
    );
  }
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}
