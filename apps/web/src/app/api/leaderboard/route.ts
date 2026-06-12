/**
 * GET /api/leaderboard
 *
 * Ranked leaderboard JSON — the same scored/ranked data the dashboard renders,
 * exposed programmatically. Supports both the cross-region Overall blend
 * (default) and a single-region board.
 *
 * Query params (all optional):
 *   region   a GEO_REGIONS value, or "overall"  (default: overall)
 *   infra    a worker_provider key (concrete region only; default: pooled)
 *   method   an ALL_METHODS value               (default: getTransaction)
 *   mode     "cold" | "warm"                     (default: cold)
 *   window   1 | 6 | 24 | 168 | 720 (hours)      (default: 24)
 *   eligibleOnly  "1"/"true" → drop ineligible providers
 *
 * No auth — same public data the dashboard renders. See /api-reference.
 */

import {
  ParamError,
  badRequest,
  parseBool,
  parseInfra,
  parseMethod,
  parseMode,
  parseRegion,
  parseWindow,
} from "@/lib/apiParams";
import { fetchLeaderboard } from "@/lib/leaderboardApi";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  let params;
  try {
    const region = parseRegion(q.get("region"));
    params = {
      region,
      infra: parseInfra(q.get("infra"), region),
      method: parseMethod(q.get("method")),
      connectionMode: parseMode(q.get("mode")),
      windowHours: parseWindow(q.get("window")),
      eligibleOnly: parseBool(q.get("eligibleOnly")),
    };
  } catch (e) {
    if (e instanceof ParamError) return badRequest(e.message);
    throw e;
  }

  const body = await fetchLeaderboard(params);
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
    },
  });
}
