/**
 * Shared helpers for resolving `env:VAR` placeholders in send-target config
 * (url / headers / queries). Keys are never persisted — same discipline as the
 * read panel's `resolveEndpointUrl`.
 */

/** Resolve an `env:VAR` value to its env contents, or return literals as-is. Null if the env var is unset. */
export function resolveEnvValue(v: string): string | null {
  if (v.startsWith("env:")) {
    return process.env[v.slice(4)] ?? null;
  }
  return v;
}

/** Resolve a map of `env:`-or-literal values; null if ANY referenced env var is unset. */
export function resolveEnvMap(
  m: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    const r = resolveEnvValue(v);
    if (r === null) return null;
    out[k] = r;
  }
  return out;
}

/** Append query params to a URL string. */
export function withQueries(url: string, queries: Record<string, string>): string {
  const keys = Object.keys(queries);
  if (keys.length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(queries)) u.searchParams.set(k, v);
  return u.toString();
}
