/**
 * Lightweight .env loader. Apps call `loadEnv()` at the very top of their
 * entry file (before any other import that reads process.env).
 *
 * Reads, in order, all paths it finds. Later files override earlier ones.
 * Existing process.env values are preserved (so deployment env wins over
 * local files).
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
export function loadEnv(callerImportMetaUrl: string): void {
  const here = dirname(fileURLToPath(callerImportMetaUrl));
  const root = findRepoRoot(here);
  for (const file of [".env", ".env.local"]) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    const parsed = parse(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      // Don't overwrite values that are already set in the real environment
      // (e.g. by Vercel, AWS Secrets Manager, or `KEY=val pnpm dev` overrides).
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}
