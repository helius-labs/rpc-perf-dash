/**
 * Collapse concurrent identical calls into one in-flight promise per server
 * instance.
 *
 * `unstable_cache` does not dedupe concurrent misses: every request that
 * arrives while an entry is missing or being rebuilt runs the fetcher itself.
 * When the query behind it is slow, requests stack up faster than they finish.
 * Wrap the fetcher's Impl in this so a burst of requests in one instance shares
 * one DB query. The entry is dropped as soon as the call settles, so this
 * never serves stale data; it only removes duplicate in-flight work.
 */
const inflight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key);
  if (hit) return hit as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
