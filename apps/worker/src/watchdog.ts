/**
 * Wedge guards for the worker's claim→sample loop.
 *
 * Failure mode this fixes (observed repeatedly in prod, across clouds): a
 * pooled Postgres connection goes half-open (e.g. a NAT gateway silently drops
 * an idle TCP flow after ~350s), so an `await` on a DB call in `processOne`
 * never resolves *or* rejects. The bare `while (true)` loop freezes on that
 * await forever, no exception is thrown, and — because the heartbeat is a
 * separate `setInterval` on other pool connections — the worker keeps beating
 * while emitting zero samples. The wedge is therefore invisible to any
 * heartbeat monitor and nothing restarts it (seen dark for 35min–50h).
 *
 * Two pure, testable primitives:
 *   - withTimeout: turns a hung await into a rejection so the loop resumes.
 *   - shouldSelfHeal: decides when a *sustained* failure streak means the
 *     process should exit for the orchestrator to restart it with a fresh pool.
 *
 * These are dependency-free on purpose so they can be verified without
 * standing up a DB or the whole worker (see watchdog.verify.mts).
 */

/**
 * Reject if `p` hasn't settled within `ms`. Cannot cancel the underlying work
 * (JS has no cancellation), but it frees the awaiting loop to continue instead
 * of freezing on it forever — the core fix for the wedge. The rejection is
 * caught by the loop's existing try/catch, which counts toward the failure
 * streak below.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker: '${label}' exceeded ${ms}ms — treating as a wedge`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Self-heal decision. `failingSince` is the timestamp the current *uninterrupted*
 * failure streak began, or null when the loop is healthy. The loop resets it to
 * null on any iteration that makes progress — a successful sample OR a clean
 * idle poll (claim returned no work). So:
 *   - normal operation → streak keeps resetting → never heals.
 *   - generator outage (no challenges → idle polls) → still resets → no
 *     restart storm.
 *   - genuine wedge (every iteration hangs → times out → throws) → streak grows
 *     unbroken → once it exceeds `wedgeMs`, exit for a fresh restart.
 */
export function shouldSelfHeal(
  failingSince: number | null,
  now: number,
  wedgeMs: number,
): boolean {
  return failingSince !== null && now - failingSince >= wedgeMs;
}
