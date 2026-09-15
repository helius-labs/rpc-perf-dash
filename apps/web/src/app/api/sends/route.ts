/**
 * GET /api/sends — the send leaderboard as JSON (open-data ethos).
 * Query params:
 *   `grain`    1h|1d, default 1d
 *   `scenario` optional filter
 *   `complete` 1|true — score the most recent COMPLETE bucket instead of the
 *              current, still-filling one
 *
 * `window_start` / `window_end` bound the period the rows describe. They exist
 * so a consumer that republishes these numbers (the snapshot embed, a press
 * chart) can date them to the DATA rather than to the clock at fetch time — and
 * `complete=1` is what makes that date meaningful, since the default view's
 * newest bucket is a partial day that isn't over yet.
 */

import { NextResponse } from "next/server";
import { fetchSendBoard, fetchSendBoardComplete } from "@/lib/sends";

export const revalidate = 120;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const grain = url.searchParams.get("grain") === "1h" ? "1h" : "1d";
  const scenario = url.searchParams.get("scenario") ?? undefined;
  const completeParam = url.searchParams.get("complete");
  const complete = completeParam === "1" || completeParam === "true";
  try {
    // The live path keeps returning a bare row list plus null bounds: its
    // newest bucket is still filling, so there is no completed period to name.
    const { window, rows } = complete
      ? await fetchSendBoardComplete(grain, scenario)
      : { window: null, rows: await fetchSendBoard(grain, scenario) };
    return NextResponse.json({
      grain,
      scenario: scenario ?? null,
      complete,
      window_start: window?.window_start ?? null,
      window_end: window?.window_end ?? null,
      rows,
    });
  } catch (err) {
    console.error("[api/sends]", (err as Error).message);
    return NextResponse.json({ error: "database temporarily unavailable" }, { status: 503 });
  }
}
