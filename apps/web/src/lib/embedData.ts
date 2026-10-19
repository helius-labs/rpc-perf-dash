/**
 * Server-side data assembly shared by the full-page dashboard routes and the
 * chromeless /embed/* widget routes, so the two never drift.
 *
 * Scope: the *server-assembled inputs* to the client wrapper components only.
 * The wrappers' client tuning state (component/region/method weights, selected
 * methods) lives inside <OverviewBoard>/<MethodRegionTabs> and is intentionally
 * NOT here — the embeds are preset-driven and reuse that same in-component
 * blending, so a leaderboard embed and a score embed built off the same cube
 * always agree.
 *
 * These helpers do the raw fetch + shape work and let errors propagate; callers
 * wrap in try/catch (dashboard pages → inline banner; embed pages → error.tsx).
 */

import { GEO_REGIONS, type GeoRegion } from "@rpcbench/shared";
import { MIN_METHOD_COVERAGE } from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "./methods";
import {
  fetchActiveGeos,
  fetchAggregatesForGeoByMethod,
  fetchConsensusRunEnds,
  RUN_END_LOOKBACKS_H,
  fetchMethodLatency,
  fetchMethodGeoLatency,
  type MethodLatencyRow,
} from "./leaderboard";
import { fetchSampleCount, type SampleCount } from "./sampleCount";
import { type MethodGeoRows } from "@/components/leaderboardShared";
import { type MethodRegionLatency } from "@/components/IndexLeaderboard";
import {
  type BreakdownRow,
  type CubeRow,
  type InfraTableData,
} from "@/components/MethodRegionTabs";

/** The overview mode is always cold — matches the home board and its share card. */
export const OVERVIEW_MODE = "cold" as const;

export interface OverviewBoardData {
  cube: MethodGeoRows[];
  methodRegionLatency: MethodRegionLatency;
  sampleCount: SampleCount;
  methodCount: number;
  /** Set when the live window couldn't rank anyone and the cube is the last
   *  window that could: the ISO hour boundary that window ends at. Null = live. */
  staleAsOf: string | null;
}

/**
 * Whether any provider clears the method-coverage gate on this cube, i.e.
 * whether the board will rank anyone. Coverage is counted over every method in
 * the cube with equal weight: a method counts for a provider when it is
 * eligible in at least one geo. That mirrors blendMethodScores under the
 * all-methods preset. A weighted preset can disagree at the margin, but losing
 * consensus zeroes eligibility everywhere, so every preset fails together in the
 * case this guards.
 */
export function isCubeRankable(
  cube: MethodGeoRows[],
  minCoverage: number = MIN_METHOD_COVERAGE,
): boolean {
  const methods = new Set(cube.map((c) => c.method));
  if (methods.size === 0) return false;
  const covered = new Map<string, Set<string>>();
  for (const cell of cube) {
    for (const r of cell.eligible) {
      let set = covered.get(r.provider_id);
      if (!set) covered.set(r.provider_id, (set = new Set()));
      set.add(cell.method);
    }
  }
  for (const set of covered.values()) {
    if (set.size / methods.size >= minCoverage) return true;
  }
  return false;
}

/**
 * The five-prop <OverviewBoard> feed minus presetId (the caller supplies that):
 * the per-(method, geo) cube over ALL methods + active geos, the
 * provider→method→geo latency map for the expandable grid, the live sample
 * count, and the total method count. One multi-method query per geo (≤6), not
 * one per method — the cube carries every method because any can be toggled in
 * client-side.
 */
/** Most stale windows built per request while looking for one that ranks. Each
 *  is a full 6-geo cube, so this bounds the fallback's DB cost. */
const MAX_FALLBACK_PROBES = 3;

export async function buildOverviewBoardData(windowHours: number): Promise<OverviewBoardData> {
  const activeGeos = await fetchActiveGeos();
  const targets = activeGeos.length > 0 ? activeGeos : [...GEO_REGIONS];

  const [live, sampleCount] = await Promise.all([
    buildCube(targets, windowHours),
    fetchSampleCount(),
  ]);
  const base = { sampleCount, methodCount: ALL_METHODS.length };
  if (isCubeRankable(live.cube)) return { ...live, ...base, staleAsOf: null };

  // Stale fallback. The live window ranks nobody, which is what happens when
  // fewer than MIN_CONSENSUS_VOTERS providers are reporting: every sample turns
  // no_consensus and eligibility drops to zero, so one outage at other
  // providers would blank the board. Serve the most recent window that does
  // rank, labelled with when it ends, until the live window recovers. Never
  // throws: on any failure the live (empty) board renders as before.
  try {
    const tried = new Set<string>();
    for (const lookbackH of RUN_END_LOOKBACKS_H) {
      const ends = await fetchConsensusRunEnds(OVERVIEW_MODE, lookbackH, windowHours);
      for (const endAt of ends) {
        if (tried.has(endAt)) continue;
        if (tried.size >= MAX_FALLBACK_PROBES) return { ...live, ...base, staleAsOf: null };
        tried.add(endAt);
        const stale = await buildCube(targets, windowHours, endAt);
        if (isCubeRankable(stale.cube)) return { ...stale, ...base, staleAsOf: endAt };
      }
    }
  } catch (err) {
    console.error("[buildOverviewBoardData] stale fallback failed", err);
  }
  return { ...live, ...base, staleAsOf: null };
}

async function buildCube(
  targets: readonly GeoRegion[],
  windowHours: number,
  endAt?: string,
): Promise<Pick<OverviewBoardData, "cube" | "methodRegionLatency">> {
  const byGeo = await Promise.all(
    targets.map(async (geo) => ({
      geo,
      byMethod: await fetchAggregatesForGeoByMethod({
        geoRegion: geo,
        methods: ALL_METHODS,
        windowHours,
        connectionMode: OVERVIEW_MODE,
        ...(endAt ? { endAt } : {}),
      }),
    })),
  );

  const cube: MethodGeoRows[] = [];
  const methodRegionLatency: MethodRegionLatency = {};
  for (const { geo, byMethod } of byGeo) {
    for (const { method, rows } of byMethod) {
      const eligible = rows.filter(
        (r) => r.eligible === true && r.p50_ms !== null && r.p95_ms !== null,
      );
      cube.push({ method, geo, rows, eligible });
      for (const r of rows) {
        ((methodRegionLatency[r.provider_id] ??= {})[method] ??= {})[geo] = {
          p50: r.p50_ms,
          p95: r.p95_ms,
        };
      }
    }
  }

  return { cube, methodRegionLatency };
}

/**
 * The <MethodRegionTabs> `byInfra` feed: for each infra key ("all" + each active
 * worker_provider) the per-method p50/p95 rows (cold+warm) and the raw
 * method×geo cube rows for the expandable region drill-down. Pre-fetches every
 * infra so the table's Infra dropdown switches client-side.
 */
export async function buildLatencyTableData({
  infraKeys,
  windowHours,
  tableProviders,
}: {
  infraKeys: string[];
  windowHours: number;
  tableProviders: { id: string; name: string }[];
}): Promise<Record<string, InfraTableData>> {
  const [mlByInfra, mglByInfra] = await Promise.all([
    Promise.all(
      infraKeys.map((k) =>
        fetchMethodLatency({ windowHours, ...(k !== "all" ? { workerProvider: k } : {}) }),
      ),
    ),
    Promise.all(
      infraKeys.map((k) =>
        fetchMethodGeoLatency({ windowHours, ...(k !== "all" ? { workerProvider: k } : {}) }),
      ),
    ),
  ]);

  const buildMethodRows = (ml: MethodLatencyRow[]): BreakdownRow[] =>
    [...ALL_METHODS]
      .sort((a, b) => a.localeCompare(b))
      .map((m) => ({
        key: m,
        label: m,
        isCode: true,
        values: Object.fromEntries(
          tableProviders.map((p) => {
            const cold = ml.find(
              (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "cold",
            );
            const warm = ml.find(
              (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "warm",
            );
            return [
              p.id,
              {
                cold: { p50: cold?.p50 ?? null, p95: cold?.p95 ?? null },
                warm: { p50: warm?.p50 ?? null, p95: warm?.p95 ?? null },
              },
            ];
          }),
        ),
      }));

  const byInfra: Record<string, InfraTableData> = {};
  infraKeys.forEach((key, i) => {
    byInfra[key] = {
      methodRows: buildMethodRows(mlByInfra[i] ?? []),
      cubeRows: (mglByInfra[i] ?? []) as CubeRow[],
    };
  });
  return byInfra;
}
