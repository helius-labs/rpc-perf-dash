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
 * Three limits keep the slow lane from making things worse:
 * - Request budget: `remainingMs()` is the time left in the current request
 *   (undefined = no request scope). Both lanes are clipped to it, a read that
 *   starts with too little left fails at once, and the slow lane is only
 *   tried when at least `fastMs` remains. Sequential reads in one request
 *   therefore can't add up past the function's duration limit.
 * - Lane full: past `maxSlow`, a read fails with its fast-lane timeout instead
 *   of queueing.
 * - Give-up: a query whose slow-lane run also timed out isn't escalated again
 *   for `giveUpMs`, so a saturated DB isn't handed a doomed 40s retry on every
 *   request.
 *
 * Queries that needed the slow lane (and finished) are remembered, bounded,
 * and go straight to it next time, so the fast attempt isn't wasted on every
 * refresh.
 */
export interface BoundedReadOptions {
  fastMs: number;
  slowMs: number;
  /** Max concurrent slow-lane reads per server instance. */
  maxSlow: number;
  /** Max remembered slow / given-up queries each (oldest evicted first). */
  knownSlowLimit: number;
  /** How long a query whose slow-lane run timed out is kept off the slow lane. */
  giveUpMs: number;
  /** Time left in the current request's read budget, or undefined if none. */
  remainingMs?: () => number | undefined;
  /** A read with less than this left in its budget isn't started (default 500). */
  minReadMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export type TimedRun<Q, R> = (query: Q, timeoutMs: number) => Promise<R>;

class SlowLaneFull extends Error {}

/** Thrown when a read starts after its request's read budget is spent. */
export class ReadBudgetExhausted extends Error {
  constructor() {
    super("request read budget exhausted");
  }
}

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

/** Insertion-ordered set/map bounded to `limit` entries, oldest evicted. */
function touch<K, V>(m: Map<K, V>, key: K, value: V, limit: number) {
  m.delete(key);
  m.set(key, value);
  if (m.size > limit) m.delete(m.keys().next().value as K);
}

export function createBoundedReader<Q, R>(
  run: TimedRun<Q, R>,
  keyOf: (query: Q) => string,
  opts: BoundedReadOptions,
): (query: Q) => Promise<R> {
  const now = opts.now ?? Date.now;
  const minReadMs = opts.minReadMs ?? 500;
  const knownSlow = new Map<string, true>();
  const gaveUpUntil = new Map<string, number>();
  let slowInUse = 0;

  const remaining = () => opts.remainingMs?.() ?? Number.POSITIVE_INFINITY;
  const gaveUp = (key: string) => (gaveUpUntil.get(key) ?? 0) > now();

  /** The shared slow-lane run for `key`. Its timeout is set by whichever
   *  request starts it; a request that joins it waits at most its own
   *  remaining budget (`waitMs`) and then fails with `onBudget`. */
  const slowLane = (query: Q, key: string, timeoutMs: number, waitMs: number, onBudget: () => Error) => {
    const flight = singleFlight(`slow:${key}`, async () => {
      if (slowInUse >= opts.maxSlow) throw new SlowLaneFull();
      slowInUse++;
      const started = now();
      try {
        const result = await run(query, timeoutMs);
        // It fit the fast budget this time (warm cache, quieter DB): stop
        // routing it to the slow lane.
        if (now() - started < opts.fastMs) knownSlow.delete(key);
        else touch(knownSlow, key, true, opts.knownSlowLimit);
        return result;
      } catch (err) {
        if (isStatementTimeout(err)) {
          knownSlow.delete(key);
          touch(gaveUpUntil, key, now() + opts.giveUpMs, opts.knownSlowLimit);
        }
        throw err;
      } finally {
        slowInUse--;
      }
    });
    // The flight may have been started by another request with a longer
    // timeout, so a request with a budget always races it.
    if (!Number.isFinite(waitMs)) return flight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onBudget()), waitMs);
    });
    return Promise.race([flight, budget]).finally(() => clearTimeout(timer));
  };

  return async (query: Q): Promise<R> => {
    const key = keyOf(query);
    const rem0 = remaining();
    if (rem0 < minReadMs) throw new ReadBudgetExhausted();

    if (knownSlow.has(key) && !gaveUp(key) && rem0 >= opts.fastMs) {
      try {
        return await slowLane(query, key, Math.min(opts.slowMs, rem0), rem0, () => new ReadBudgetExhausted());
      } catch (err) {
        if (!(err instanceof SlowLaneFull)) throw err;
        // Lane busy: fall through and take the fast attempt instead.
      }
    }

    const fastTimeout = Math.min(opts.fastMs, remaining());
    if (fastTimeout < minReadMs) throw new ReadBudgetExhausted();
    try {
      return await run(query, fastTimeout);
    } catch (err) {
      if (!isStatementTimeout(err)) throw err;
      const rem1 = remaining();
      // Escalate only with budget for a real retry, and not for a query whose
      // last slow-lane run also timed out.
      if (rem1 < opts.fastMs || gaveUp(key)) throw err;
      try {
        return await slowLane(query, key, Math.min(opts.slowMs, rem1), rem1, () => err as Error);
      } catch (slowErr) {
        throw slowErr instanceof SlowLaneFull ? err : slowErr;
      }
    }
  };
}
