import { parseShareParams } from "@/lib/share";
import { OverviewBoard } from "@/components/OverviewBoard";
import { type MethodRegionLatency } from "@/components/IndexLeaderboard";
import { type MethodGeoRows } from "@/components/leaderboardShared";
import { buildOverviewBoardData } from "@/lib/embedData";
import { EMPTY_SAMPLE_COUNT, type SampleCount } from "@/lib/sampleCount";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  preset?: string;
  window?: string;
}

/**
 * Embeddable ranked leaderboard. Reuses the same <OverviewBoard> wrapper the
 * home page renders, fed by the shared buildOverviewBoardData(). Honors
 * `preset` + `window` only — OverviewBoard derives methods/weights/regions from
 * the preset and forces cold mode (mode/methods/regions/infra are ignored).
 */
export default async function EmbedLeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseShareParams(params as Record<string, string | undefined>);

  let cube: MethodGeoRows[] = [];
  let methodRegionLatency: MethodRegionLatency = {};
  let sampleCount: SampleCount = EMPTY_SAMPLE_COUNT;
  let methodCount = 0;
  let error: string | null = null;
  try {
    ({ cube, methodRegionLatency, sampleCount, methodCount } =
      await buildOverviewBoardData(filters.windowHours));
  } catch (err) {
    console.error("[embed/leaderboard]", err);
    error = DB_ERROR_MESSAGE;
  }

  if (error) {
    return (
      <div className="badge bad" style={{ display: "block", padding: 12 }} role="alert">
        Leaderboard unavailable: {error}
      </div>
    );
  }

  return (
    <OverviewBoard
      cube={cube}
      presetId={filters.presetId}
      methodRegionLatency={methodRegionLatency}
      sampleCount={sampleCount}
      methodCount={methodCount}
      embed
    />
  );
}
