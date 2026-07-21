/**
 * GET /api/providers/[id]
 *
 * Single-provider deep dive: the provider's overall (cross-region blend) rank,
 * composite score, per-geo sub-score breakdown, blended percentiles, win-rate,
 * call totals, and failure breakdown — pulled from the same Overall board
 * /api/leaderboard returns, so the numbers agree across endpoints.
 *
 * [id] accepts the provider slug (e.g. "helius") or the raw provider_id
 * (e.g. "helius"); unknown ids 404.
 *
 * Params: method / mode / window (same defaults as /api/leaderboard).
 *
 * Note: scores are RELATIVE to the current field — a single-provider query
 * can't yield an absolute score. `rank` is null when the provider is ineligible
 * in every region. No auth. See /api-reference.
 */

import {
  benchmarkedProviderByRouteParam,
  providerSlug,
  METHODOLOGY_VERSION,
} from "@rpcbench/shared";
import {
  ParamError,
  badRequest,
  parseMethod,
  parseMode,
  parseWindow,
} from "@/lib/apiParams";
import { fetchLeaderboard } from "@/lib/leaderboardApi";
import { DEFAULT_PRESET_ID, isPresetId } from "@/lib/workloadPresets";

function notFoundJson(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: routeParam } = await params;
  const provider = benchmarkedProviderByRouteParam(routeParam);
  if (!provider) return notFoundJson(`unknown provider '${routeParam}'`);

  const q = new URL(req.url).searchParams;
  let method, connectionMode, windowHours;
  try {
    method = parseMethod(q.get("method"));
    connectionMode = parseMode(q.get("mode"));
    windowHours = parseWindow(q.get("window"));
  } catch (e) {
    if (e instanceof ParamError) return badRequest(e.message);
    throw e;
  }

  // Default overall = preset method-blend (Balanced); an explicit method= keeps
  // the legacy single-method overall.
  const presetRaw = q.get("preset");
  const board = await fetchLeaderboard({
    region: "overall",
    method,
    methodExplicit: q.get("method") != null,
    preset: isPresetId(presetRaw) ? presetRaw : DEFAULT_PRESET_ID,
    connectionMode,
    windowHours,
    eligibleOnly: false,
  });
  const row =
    (board.rows as Array<{ provider_id: string }>).find(
      (r) => r.provider_id === provider.id,
    ) ?? null;

  const body = {
    meta: {
      provider_id: provider.id,
      provider_name: provider.name,
      slug: providerSlug(provider),
      method,
      connection_mode: connectionMode,
      window_hours: windowHours,
      methodology_version: METHODOLOGY_VERSION,
      eligible_count: board.meta.eligible_count,
      generated_at: board.meta.generated_at,
    },
    row,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
    },
  });
}
