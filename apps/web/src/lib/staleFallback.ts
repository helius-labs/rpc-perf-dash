/**
 * Search order for the per-provider stale leaderboard fallback (see
 * buildOverviewBoardData). Kept free of DB/Next imports so the orchestration is
 * unit-testable.
 *
 * Every provider the live window can't rank gets its own most recent window
 * that does rank it, so one provider's outage never hides another's last good
 * result, and different providers' windows may end at different times.
 *
 * Candidates arrive per provider, newest first. Building a window is the
 * expensive step (a full 6-geo cube), so a built window is shared by every
 * provider whose candidate has the same key (providers that went dark together
 * usually share an end), and the number of builds is capped at `maxBuilds`.
 * Once the cap is hit, providers can still use windows already built. A build
 * that throws is reported via `onError` and treated as ranking nobody.
 */
import { leaderboardGrainForWindow } from "@rpcbench/shared";
import { MIN_METHOD_COVERAGE } from "@rpcbench/shared/scoring";
import type { MethodGeoRows } from "@/components/leaderboardShared";

export interface StaleCandidate {
  /** ISO bucket boundary the window ends at. */
  endAt: string;
  grain: "1h" | "1d";
}

export interface FindProviderWindowsOptions<W> {
  providers: readonly string[];
  /** Candidate windows for one provider, newest first. */
  candidates: (providerId: string) => readonly StaleCandidate[];
  build: (c: StaleCandidate) => Promise<W>;
  /** Whether the built window ranks this provider. */
  ranks: (window: W, providerId: string) => boolean;
  maxBuilds: number;
  onError?: (stage: string, err: unknown) => void;
}

export interface ProviderWindow<W> {
  candidate: StaleCandidate;
  window: W;
}

export async function findProviderWindows<W>(
  opts: FindProviderWindowsOptions<W>,
): Promise<Map<string, ProviderWindow<W>>> {
  const built = new Map<string, W | null>(); // null = build failed
  const found = new Map<string, ProviderWindow<W>>();

  const get = async (c: StaleCandidate): Promise<W | null> => {
    const key = `${c.grain}|${c.endAt}`;
    if (built.has(key)) return built.get(key)!;
    if (built.size >= opts.maxBuilds) return null;
    let w: W | null = null;
    try {
      w = await opts.build(c);
    } catch (err) {
      opts.onError?.(`build ${key}`, err);
    }
    built.set(key, w);
    return w;
  };

  for (const providerId of opts.providers) {
    for (const candidate of opts.candidates(providerId)) {
      const window = await get(candidate);
      if (window !== null && opts.ranks(window, providerId)) {
        found.set(providerId, { candidate, window });
        break;
      }
    }
  }
  return found;
}

/** A candidate end for one provider (see fetchProviderRunEnds). */
export interface RunEnd {
  provider_id: string;
  endAt: string;
}

/**
 * Providers that clear the method-coverage gate on this cube, i.e. the ones
 * the board will rank. Coverage is counted over every method in the cube with
 * equal weight: a method counts for a provider when it is eligible in at least
 * one geo. That mirrors blendMethodScores under the all-methods preset. A
 * weighted preset can disagree at the margin, but losing consensus zeroes
 * eligibility everywhere, so every preset fails together in the case this
 * guards.
 */
export function rankableProviders(
  cube: MethodGeoRows[],
  minCoverage: number = MIN_METHOD_COVERAGE,
): Set<string> {
  const out = new Set<string>();
  const methods = new Set(cube.map((c) => c.method));
  if (methods.size === 0) return out;
  const covered = new Map<string, Set<string>>();
  for (const cell of cube) {
    for (const r of cell.eligible) {
      let set = covered.get(r.provider_id);
      if (!set) covered.set(r.provider_id, (set = new Set()));
      set.add(cell.method);
    }
  }
  for (const [id, set] of covered) {
    if (set.size / methods.size >= minCoverage) out.add(id);
  }
  return out;
}

/**
 * The live cube with each `stale` provider's rows swapped for its rows from its
 * own window. Cells keep the live cube's (method, geo) set; a stale provider
 * missing from a cell of its window is left out of that cell.
 */
export function mergeProviderCubes(
  live: MethodGeoRows[],
  stale: ReadonlyMap<string, MethodGeoRows[]>,
): MethodGeoRows[] {
  if (stale.size === 0) return live;
  const staleCells = new Map<string, Map<string, MethodGeoRows>>();
  for (const [id, cube] of stale) {
    staleCells.set(id, new Map(cube.map((c) => [`${c.method}|${c.geo}`, c])));
  }
  return live.map((cell) => {
    const rows = cell.rows.filter((r) => !stale.has(r.provider_id));
    const eligible = cell.eligible.filter((r) => !stale.has(r.provider_id));
    for (const [id, cells] of staleCells) {
      const sc = cells.get(`${cell.method}|${cell.geo}`);
      const row = sc?.rows.find((r) => r.provider_id === id);
      if (row) rows.push(row);
      const el = sc?.eligible.find((r) => r.provider_id === id);
      if (el) eligible.push(el);
    }
    return { ...cell, rows, eligible };
  });
}

/**
 * Candidate windows for one provider, newest first: up to 2 run ends from the
 * 1h precompute, then up to 2 from the 1d precompute for outages older than the
 * 1h retention. Windows over 7 days read the 1d grain anyway, so they only get
 * 1d candidates.
 */
export function staleCandidates(
  providerId: string,
  windowHours: number,
  hourly: readonly RunEnd[],
  daily: readonly RunEnd[],
): StaleCandidate[] {
  const pick = (ends: readonly RunEnd[], grain: StaleCandidate["grain"]) =>
    ends
      .filter((e) => e.provider_id === providerId)
      .slice(0, 2)
      .map((e) => ({ endAt: e.endAt, grain }));
  const daySide = pick(daily, "1d");
  return leaderboardGrainForWindow(windowHours) === "1d" ? daySide : [...pick(hourly, "1h"), ...daySide];
}

/**
 * Window length a candidate is built over. A 1d candidate covers whole days, so
 * a shorter selected window (1h, 6h) widens to one day.
 */
export function staleWindowHours(windowHours: number, grain: StaleCandidate["grain"]): number {
  return grain === "1d" ? Math.max(1, Math.ceil(windowHours / 24)) * 24 : windowHours;
}
