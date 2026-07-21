/**
 * GET /api/by-method?window=24
 *
 * Per-(method × provider × cold/warm) p50 + p95 over the window, pooled across
 * all regions — the same matrix the home page's "By method" breakdown renders.
 * One row per (method, provider_id, connection_mode).
 *
 * No auth — same public data the dashboard renders. See /api-reference.
 */

import { ParamError, badRequest, parseWindow } from "@/lib/apiParams";
import { fetchMethodLatency } from "@/lib/leaderboard";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  let windowHours: number;
  try {
    windowHours = parseWindow(q.get("window"));
  } catch (e) {
    if (e instanceof ParamError) return badRequest(e.message);
    throw e;
  }

  const rows = await fetchMethodLatency({ windowHours });
  const body = {
    meta: { window_hours: windowHours, generated_at: new Date().toISOString() },
    rows,
  };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
    },
  });
}
