/**
 * Read-API data layer for /api/leaderboard. A thin wrapper over the same cached
 * fetchers + scoring the dashboard SSR uses, so the API ranks providers
 * identically to the UI:
 *   - region="overall" (default) ranks by the workload-preset method-blend
 *     (fetchRankedPreset, default Balanced), so "overall" is the same
 *     number the homepage shows;
 *   - region="overall" WITH an explicit method= falls back to the legacy
 *     single-method cross-region blend (fetchRankedOverall);
 *   - a concrete region uses the single-region board.
 *
 * The only thing added here is the `rank` field, injected at this layer.
 */

import { unstable_cache } from "next/cache";
import {
  METHODOLOGY_VERSION,
  type ConnectionMode,
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import {
  DEFAULT_WEIGHTS,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import {
  CACHE_TTL_S,
  fetchAggregatesForGeo,
  fetchRankedOverall,
  fetchRankedPreset,
} from "@/lib/leaderboard";
import {
  buildSingleLeaderRows,
  scorePerGeo,
  type OverallLeaderRow,
  type PresetLeaderRow,
  type SingleLeaderRow,
} from "@/components/leaderboardShared";
import { presetById, type PresetId } from "@/lib/workloadPresets";

export interface LeaderboardParams {
  region: GeoRegion | "overall";
  /** Only meaningful when `region` is concrete; pooled (`__all__`) otherwise. */
  infra?: string | undefined;
  method: Method;
  /** Was `method=` explicitly supplied? Forces the legacy single-method overall. */
  methodExplicit: boolean;
  /** Workload preset for the default overall blend. */
  preset: PresetId;
  connectionMode: ConnectionMode;
  windowHours: number;
  eligibleOnly: boolean;
}

export type RankedRegionRow = SingleLeaderRow & { rank: number | null };
export type RankedOverallRow = OverallLeaderRow & { rank: number | null };
export type RankedPresetRow = PresetLeaderRow & { rank: number | null };

export interface LeaderboardResponse {
  meta: {
    mode: "preset" | "overall" | "region";
    region: GeoRegion | "overall";
    preset: PresetId | null;
    infra: string | null;
    method: Method;
    connection_mode: ConnectionMode;
    window_hours: number;
    methodology_version: number;
    weights: ScoringWeights;
    eligible_count: number;
    generated_at: string;
  };
  rows: RankedRegionRow[] | RankedOverallRow[] | RankedPresetRow[];
}

/** A provider has an overall (blended) ranking iff it's eligible in ≥1 region. */
function overallEligible(row: OverallLeaderRow): boolean {
  return Object.values(row.per_geo).some((v) => v != null);
}

async function fetchLeaderboardImpl(
  params: LeaderboardParams,
): Promise<LeaderboardResponse> {
  const { region, infra, method, methodExplicit, preset, connectionMode, windowHours, eligibleOnly } =
    params;

  let rows: RankedRegionRow[] | RankedOverallRow[] | RankedPresetRow[];
  let eligibleCount: number;
  // Default overall = preset method-blend; explicit method= keeps the legacy
  // single-method overall.
  const usePreset = region === "overall" && !methodExplicit;
  const mode: LeaderboardResponse["meta"]["mode"] =
    region === "overall" ? (usePreset ? "preset" : "overall") : "region";

  if (usePreset) {
    const presetRows = await fetchRankedPreset({
      presetId: preset,
      windowHours,
      connectionMode,
    });
    let r = 0;
    let ranked: RankedPresetRow[] = presetRows.map((row) => ({
      ...row,
      rank: row.coverage_ok ? ++r : null,
    }));
    eligibleCount = r;
    if (eligibleOnly) ranked = ranked.filter((row) => row.rank != null);
    rows = ranked;
  } else if (region === "overall") {
    const overall = await fetchRankedOverall({
      windowHours,
      connectionMode,
      method,
    });
    // Already sorted by score desc; eligible rows lead, so iteration order gives
    // the rank. Ineligible providers keep rank: null.
    let r = 0;
    let ranked: RankedOverallRow[] = overall.map((row) => ({
      ...row,
      rank: overallEligible(row) ? ++r : null,
    }));
    eligibleCount = r;
    if (eligibleOnly) ranked = ranked.filter((row) => row.rank != null);
    rows = ranked;
  } else {
    const agg = await fetchAggregatesForGeo({
      geoRegion: region,
      windowHours,
      connectionMode,
      method,
      // Omit entirely when pooled — AggregateOpts.workerProvider is optional
      // under exactOptionalPropertyTypes, so it must be absent, not `undefined`.
      ...(infra !== undefined ? { workerProvider: infra } : {}),
    });
    const eligible = agg.filter(
      (x) => x.eligible === true && x.p50_ms != null && x.p95_ms != null,
    );
    const scored = scorePerGeo({ eligible }, DEFAULT_WEIGHTS);
    const { rows: leaderRows } = buildSingleLeaderRows({
      geo: region,
      rows: agg,
      eligible,
      scored,
    });
    let r = 0;
    let ranked: RankedRegionRow[] = leaderRows.map((row) => ({
      ...row,
      rank: row.eligible ? ++r : null,
    }));
    eligibleCount = r;
    if (eligibleOnly) ranked = ranked.filter((row) => row.rank != null);
    rows = ranked;
  }

  return {
    meta: {
      mode,
      region,
      preset: usePreset ? preset : null,
      infra: infra ?? null,
      method,
      connection_mode: connectionMode,
      window_hours: windowHours,
      methodology_version: METHODOLOGY_VERSION,
      // The preset board scores with the preset's own component weights
      // (fetchRankedPreset); the legacy single-method/region boards use the
      // defaults. Report whichever was actually applied.
      weights: usePreset ? presetById(preset).weights : DEFAULT_WEIGHTS,
      eligible_count: eligibleCount,
      generated_at: new Date().toISOString(),
    },
    rows,
  };
}

/**
 * Cached on the same 30s tick as the SSR fetchers it composes, keyed on the
 * normalized params (unstable_cache hashes the args), so concurrent API hits for
 * the same query coalesce onto one DB read instead of N.
 */
export const fetchLeaderboard = unstable_cache(
  fetchLeaderboardImpl,
  ["api-leaderboard"],
  { revalidate: CACHE_TTL_S },
);
