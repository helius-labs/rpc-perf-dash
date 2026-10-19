/**
 * Search order for the stale leaderboard fallback (see buildOverviewBoardData).
 * Kept free of DB/Next imports so the orchestration is unit-testable.
 *
 * Candidates arrive in passes (narrow lookback first, then wider; the passes
 * don't overlap). Each probe builds a full stale cube, so probes are capped at
 * `maxProbes`, and that budget is split so a later, wider pass always gets at
 * least one probe: a run of recent windows that can't rank (e.g. several
 * short recoveries during a long outage) can't use up the whole budget before
 * the older window that would rank is even looked at.
 *
 * Within a pass, `good` candidates (mostly-healthy windows) are probed first.
 * A wider pass spends its reserved probe on its best candidate even if that
 * one isn't good, since nothing older will be offered. Anything a pass
 * couldn't afford, and the remaining not-good candidates, are kept and probed
 * after the last pass if budget remains, newest first. A pass whose lookup
 * fails, or a probe that throws, is reported via `onError` and skipped.
 */
export interface StaleCandidate {
  endAt: string;
  good: boolean;
}

export interface FindRankableWindowOptions<T> {
  /** Number of lookback passes. */
  passes: number;
  /** Candidates for pass i, newest first within each `good` group. */
  fetchPass: (pass: number) => Promise<StaleCandidate[]>;
  /** Build the stale window ending at `endAt`; non-null if it ranks. */
  probe: (endAt: string) => Promise<T | null>;
  maxProbes: number;
  onError?: (stage: string, err: unknown) => void;
}

export async function findRankableWindow<T>(opts: FindRankableWindowOptions<T>): Promise<T | null> {
  const tried = new Set<string>();
  const later: string[] = []; // good but over this pass's share
  const deferred: string[] = []; // not good

  const tryProbe = async (endAt: string): Promise<T | null> => {
    if (tried.has(endAt) || tried.size >= opts.maxProbes) return null;
    tried.add(endAt);
    try {
      return await opts.probe(endAt);
    } catch (err) {
      opts.onError?.(`probe ${endAt}`, err);
      return null;
    }
  };

  for (let pass = 0; pass < opts.passes; pass++) {
    // Leave one probe for each wider pass still to come.
    const share = opts.maxProbes - (opts.passes - 1 - pass);
    let candidates: StaleCandidate[];
    try {
      candidates = await opts.fetchPass(pass);
    } catch (err) {
      opts.onError?.(`pass ${pass}`, err);
      continue;
    }
    let probedThisPass = 0;
    for (const { endAt, good } of candidates) {
      if (tried.has(endAt)) continue;
      const reserved = pass > 0 && probedThisPass === 0;
      if ((good || reserved) && tried.size < share) {
        probedThisPass++;
        const hit = await tryProbe(endAt);
        if (hit !== null) return hit;
      } else if (good) {
        later.push(endAt);
      } else {
        deferred.push(endAt);
      }
    }
  }

  for (const endAt of [...later, ...deferred]) {
    const hit = await tryProbe(endAt);
    if (hit !== null) return hit;
  }
  return null;
}
