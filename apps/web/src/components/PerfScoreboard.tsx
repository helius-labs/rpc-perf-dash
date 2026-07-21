"use client";

/**
 * PerfScoreboard — the Performance page's overall-score board (above the chart's
 * filter bar). Owns the per-method weight state so the board re-ranks instantly
 * as the user tunes weights, with no server round-trip. Two input paths:
 *
 *   - cube (multi-method): the per-(method, geo) aggregates, re-blended
 *     client-side via buildPresetLeaderRows on every weight change. The
 *     MethodWeightPanel is shown so the user can reweight the selected methods.
 *   - prebuiltRows (single method): server-computed rows rendered as-is; a single
 *     method always normalizes to 100%, so there's nothing to tune (no panel).
 *
 * Region weighting matches the chart's Score series and the single-method
 * buildMiniScoreRows path: DEFAULT_REGION_WEIGHTS, renormalized over the geos
 * present in the cube (which the server already restricts to the selection).
 *
 * The ShareButton lives here (not the header) so the shared link carries the
 * live method weights + the selected region subset.
 */

import { useMemo, useState } from "react";
import {
  DEFAULT_REGION_WEIGHTS,
  DEFAULT_WEIGHTS,
  type MethodWeights,
} from "@rpcbench/shared/scoring";
import type { GeoRegion, Method } from "@rpcbench/shared/types";
import { equalMethodWeights } from "@/lib/workloadPresets";
import type { ShareFilters } from "@/lib/share";
import { ShareButton } from "./ShareButton";
import { ScoreStrip } from "./ScoreStrip";
import { MethodWeightPanel } from "./MethodWeightPanel";
import {
  buildPresetLeaderRows,
  type MethodGeoRows,
  type MiniScoreRow,
} from "./leaderboardShared";

export function PerfScoreboard({
  cube,
  prebuiltRows,
  selectedMethods,
  regions,
  mwOverrides,
  windowHours,
  mode,
  infra,
  loading = false,
}: {
  /** Multi-method path: per-(method, geo) cube, re-blended client-side. */
  cube?: MethodGeoRows[];
  /** Single-method path: server-computed rows, rendered as-is. */
  prebuiltRows?: MiniScoreRow[];
  selectedMethods: Method[];
  /** Effective region subset for the share card (selection, or all active). */
  regions: GeoRegion[];
  /** Per-method weight overrides parsed from the URL `mw=` param. */
  mwOverrides: MethodWeights;
  windowHours: number;
  mode: "cold" | "warm";
  infra?: string | undefined;
  /** While true, the score rows pulse (name/score cells) but the board frame,
   *  caption, and controls stay — for switching filters without blanking it. */
  loading?: boolean;
}) {
  const tunable = cube != null && selectedMethods.length > 1;

  // Seed directly from the selected methods (equal), then overlay only the mw
  // overrides that apply to a selected method. NOT via parseShareParams, whose
  // method default is the preset's set (all 45), not this page's selection.
  const [methodWeights, setMethodWeights] = useState<MethodWeights>(() => {
    const base = equalMethodWeights(selectedMethods);
    for (const m of selectedMethods) {
      if (mwOverrides[m] != null) base[m] = mwOverrides[m]!;
    }
    return base;
  });

  const rows: MiniScoreRow[] = useMemo(() => {
    if (!cube) return prebuiltRows ?? [];
    return buildPresetLeaderRows(cube, {
      componentWeights: DEFAULT_WEIGHTS,
      methodWeights,
      regionWeights: DEFAULT_REGION_WEIGHTS,
    }).map((r) => ({
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      total: r.total,
      failing_reason: r.total > 0 ? null : r.exclusion_reason,
    }));
  }, [cube, prebuiltRows, methodWeights]);

  const ranked = rows.some((r) => r.total > 0);

  const shareFilters: ShareFilters = {
    presetId: "balanced",
    methods: selectedMethods,
    methodWeights,
    regions,
    weights: DEFAULT_WEIGHTS,
    mode,
    windowHours,
    infra,
  };

  return (
    <div>
      <ScoreStrip
        rows={rows}
        ranked={ranked}
        methodCount={selectedMethods.length}
        loading={loading}
      />
      <div className="flex justify-end items-center gap-3 mt-3">
        {tunable && (
          <MethodWeightPanel
            methods={selectedMethods}
            weights={methodWeights}
            onChange={(m, value) => setMethodWeights((w) => ({ ...w, [m]: value }))}
            onReset={() => setMethodWeights(equalMethodWeights(selectedMethods))}
          />
        )}
        <ShareButton filters={shareFilters} pagePath="/performance" />
      </div>
    </div>
  );
}
