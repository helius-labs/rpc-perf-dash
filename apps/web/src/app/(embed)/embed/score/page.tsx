import type { Method } from "@rpcbench/shared";
import { parseShareParams } from "@/lib/share";
import { presetById, equalMethodWeights } from "@/lib/workloadPresets";
import { ScoreStrip } from "@/components/ScoreStrip";
import {
  buildPresetLeaderRows,
  type MiniScoreRow,
} from "@/components/leaderboardShared";
import { buildOverviewBoardData } from "@/lib/embedData";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  preset?: string;
  window?: string;
}

/**
 * Embeddable composite score strip. Uses the SAME cube + preset-derived weights
 * as the leaderboard embed (`buildPresetLeaderRows` over the preset's methods,
 * `presetById(...).weights/.regionWeights`, equal method weights) so the "#1
 * overall" here always agrees with the leaderboard. NOT `buildMiniScoreRows`
 * (that's single-method). Honors `preset` + `window` only.
 */
export default async function EmbedScorePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseShareParams(params as Record<string, string | undefined>);
  const preset = presetById(filters.presetId);
  const methods = preset.methods;
  const methodSet = new Set<string>(methods);

  let rows: MiniScoreRow[] = [];
  let error: string | null = null;
  try {
    const { cube } = await buildOverviewBoardData(filters.windowHours);
    const active = cube.filter((c) => methodSet.has(c.method as Method));
    rows = buildPresetLeaderRows(active, {
      componentWeights: preset.weights,
      methodWeights: equalMethodWeights([...methods]),
      regionWeights: preset.regionWeights,
    }).map((r) => ({
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      total: r.total,
      failing_reason: r.total > 0 ? null : r.exclusion_reason,
    }));
  } catch (err) {
    console.error("[embed/score]", err);
    error = DB_ERROR_MESSAGE;
  }

  if (error) {
    return (
      <div className="badge bad" style={{ display: "block", padding: 12 }} role="alert">
        Score strip unavailable: {error}
      </div>
    );
  }

  return (
    <ScoreStrip
      rows={rows}
      ranked={rows.some((r) => r.total > 0)}
      methodCount={methods.length}
    />
  );
}
