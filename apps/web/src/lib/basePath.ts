/**
 * The app is mounted under a basePath (see `basePath` in `next.config.ts`) so
 * it can be reverse-proxied at https://www.helius.dev/benchmarks. Next
 * auto-prefixes `<Link>`, `router.*`, and bundled assets with the basePath —
 * but NOT raw `fetch()` calls. A client `fetch("/api/…")` resolves against the
 * page origin, so under the proxy it would hit helius.dev/api/* (the wrong app)
 * and on the raw origin it would miss the now-prefixed route. Prefix every
 * client-side internal fetch with `apiPath()`.
 *
 * Keep BASE_PATH in sync with `basePath` in next.config.ts (Next has no runtime
 * API to read it back).
 */
export const BASE_PATH = "/benchmarks";

/** Prefix an app-absolute path (e.g. "/api/foo") with the basePath. */
export function apiPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
