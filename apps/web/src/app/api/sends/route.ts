/**
 * GET /api/sends — the send leaderboard as JSON (open-data ethos).
 * Query params: `grain` (1h|1d, default 1d), `scenario` (optional filter).
 *
 * `window_start` / `window_end` bound the period the rows describe. They exist
 * so a consumer that republishes these numbers (the snapshot embed, a press
 * chart) can date them to the DATA rather than to the clock at fetch time.
 */

import { NextResponse } from "next/server";
import { fetchSendBoard, fetchSendWindow } from "@/lib/sends";

export const revalidate = 120;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const grain = url.searchParams.get("grain") === "1h" ? "1h" : "1d";
  const scenario = url.searchParams.get("scenario") ?? undefined;
  try {
    const [rows, window] = await Promise.all([
      fetchSendBoard(grain, scenario),
      fetchSendWindow(grain),
    ]);
    return NextResponse.json({
      grain,
      scenario: scenario ?? null,
      window_start: window?.window_start ?? null,
      window_end: window?.window_end ?? null,
      rows,
    });
  } catch (err) {
    console.error("[api/sends]", (err as Error).message);
    return NextResponse.json({ error: "database temporarily unavailable" }, { status: 503 });
  }
}
