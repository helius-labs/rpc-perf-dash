import { singleFlight } from "./singleFlight";

/**
 * Two-lane statement timeout for web reads (see lib/db.ts for why reads are
 * capped at all).
 *
 * Every read first runs under `fastMs`. A read that hits it is retried once
 * under `slowMs` in a "slow lane": single-flighted per query, so a burst of
 * identical requests shares one retry, and limited to `maxSlow` concurrent
 * retries per server instance. Without the slow lane, a read that is valid but
 * slow (a cold 30d rollup page, a large /run aggregate) would fail on every
 * request: a timed-out read never reaches `unstable_cache`, so nothing would
 * ever be cached for it. With it, the first request pays the wait, the result
 * is cached as usual, and a pathological read still dies at `slowMs`.
 *
 * Queries that needed the slow lane are remembered (bounded) and go straight
 * to it next time, so the fast attempt isn't wasted on every refresh. If the
 * lane is full, the read fails with its original timeout instead of queueing.
 */
export interface BoundedReadOptions {
  fastMs: number;
  slowMs: number;
  /** Max concurrent slow-lane reads per server instance. */
  maxSlow: number;
  /** Max remembered slow queries (oldest evicted first). */
  knownSlowLimit: number;
}

export type TimedRun<Q, R> = (query: Q, timeoutMs: number) => Promise<R>;

class SlowLaneFull extends Error {}

/** True for Postgres' "canceling statement due to statement timeout" (57014).
 *  An operator's pg_cancel_backend shares the code but not the message, and is
 *  not retried. drizzle wraps the driver error in `cause`. */
export function isStatementTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code === "57014" && typeof message === "string" && message.includes("statement timeout")) {
      return true;
    }
  }
  return false;
}

export function createBoundedReader<Q, R>(
  run: TimedRun<Q, R>,
  keyOf: (query: Q) => string,
  opts: BoundedReadOptions,
): (query: Q) => Promise<R> {
  const knownSlow = new Set<string>();
  let slowInUse = 0;

  const remember = (key: string) => {
    knownSlow.delete(key);
    knownSlow.add(key);
    if (knownSlow.size > opts.knownSlowLimit) {
      knownSlow.delete(knownSlow.values().next().value as string);
    }
  };

  const slowLane = (query: Q, key: string): Promise<R> =>
    singleFlight(`slow:${key}`, async () => {
      if (slowInUse >= opts.maxSlow) throw new SlowLaneFull();
      slowInUse++;
      const started = Date.now();
      try {
        const result = await run(query, opts.slowMs);
        // It fit the fast budget this time (warm cache, quieter DB): stop
        // routing it to the slow lane.
        if (Date.now() - started < opts.fastMs) knownSlow.delete(key);
        return result;
      } finally {
        slowInUse--;
      }
    });

  return async (query: Q): Promise<R> => {
    const key = keyOf(query);
    if (knownSlow.has(key)) {
      try {
        return await slowLane(query, key);
      } catch (err) {
        if (!(err instanceof SlowLaneFull)) throw err;
        // Lane busy: fall through and take the fast attempt instead.
      }
    }
    try {
      return await run(query, opts.fastMs);
    } catch (err) {
      if (!isStatementTimeout(err)) throw err;
      remember(key);
      try {
        return await slowLane(query, key);
      } catch (slowErr) {
        throw slowErr instanceof SlowLaneFull ? err : slowErr;
      }
    }
  };
}
