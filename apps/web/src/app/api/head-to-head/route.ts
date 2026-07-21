/**
 * GET /api/head-to-head?a=helius&b=quicknode&method=&mode=&window=&region=
 *
 * Direct A-vs-B win rate: of the challenges both providers answered correctly,
 * how often was `a` faster than `b`. This is distinct from the leaderboard's
 * global win rate (fastest-correct across the WHOLE panel) — see
 * docs/methodology.md § Head-to-head win rate.
 *
 * `a` / `b` accept a provider slug or raw provider_id (e.g. "helius"); unknown
 * ids 404, and a === b is a 400. Params method / mode / window / region share
 * the same defaults as /api/leaderboard. "Overall" region-blends the per-geo
 * rates (DEFAULT_REGION_WEIGHTS); a concrete region is a single-geo passthrough.
 *
 * Rates are null (with a `note`) when no challenge was contested in the window —
 * e.g. one provider doesn't support the method. No auth. See /api-reference.
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
  parseRegion,
  parseWindow,
} from "@/lib/apiParams";
import { fetchHeadToHead } from "@/lib/headToHead";

function notFoundJson(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;

  const aRaw = q.get("a");
  const bRaw = q.get("b");
  if (!aRaw || !bRaw) {
    return badRequest("both 'a' and 'b' provider params are required");
  }
  const aProvider = benchmarkedProviderByRouteParam(aRaw);
  if (!aProvider) return notFoundJson(`unknown provider '${aRaw}'`);
  const bProvider = benchmarkedProviderByRouteParam(bRaw);
  if (!bProvider) return notFoundJson(`unknown provider '${bRaw}'`);
  if (aProvider.id === bProvider.id) {
    return badRequest("'a' and 'b' must be different providers");
  }

  let method, connectionMode, windowHours, region;
  try {
    method = parseMethod(q.get("method"));
    connectionMode = parseMode(q.get("mode"));
    windowHours = parseWindow(q.get("window"));
    region = parseRegion(q.get("region"));
  } catch (e) {
    if (e instanceof ParamError) return badRequest(e.message);
    throw e;
  }

  // Canonicalize on provider.id (== samples.provider_id == stored provider_a/b),
  // NOT the route param/slug — sorting raw params could silently miss rows if a
  // param ever diverged from its id. Remember whether the caller's `a` is the
  // stored provider_a so we can label the response from the caller's angle.
  const callerAIsProviderA = aProvider.id < bProvider.id;
  const providerA = callerAIsProviderA ? aProvider.id : bProvider.id;
  const providerB = callerAIsProviderA ? bProvider.id : aProvider.id;

  const res = await fetchHeadToHead({
    providerA,
    providerB,
    method,
    connectionMode,
    windowHours,
    region,
  });

  // Remap canonical a/b back to the caller's a/b.
  const aWinRate = callerAIsProviderA ? res.a_win_rate : res.b_win_rate;
  const bWinRate = callerAIsProviderA ? res.b_win_rate : res.a_win_rate;
  const aWins = callerAIsProviderA ? res.a_wins : res.b_wins;
  const bWins = callerAIsProviderA ? res.b_wins : res.a_wins;

  const body = {
    meta: {
      a: aProvider.id,
      b: bProvider.id,
      a_name: aProvider.name,
      b_name: bProvider.name,
      a_slug: providerSlug(aProvider),
      b_slug: providerSlug(bProvider),
      method,
      connection_mode: connectionMode,
      window_hours: windowHours,
      region,
      methodology_version: METHODOLOGY_VERSION,
      generated_at: new Date().toISOString(),
    },
    // a_win_rate + b_win_rate sum to 1 when contested; a_wins/b_wins/n_contested
    // are raw summed counts (the rate is the region blend, not a_wins/n_contested).
    a_win_rate: aWinRate,
    b_win_rate: bWinRate,
    a_wins: aWins,
    b_wins: bWins,
    n_contested: res.n_contested,
    ...(res.n_contested === 0
      ? { note: "no contested challenges in this window (the method may be unsupported by one provider)" }
      : {}),
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
    },
  });
}
