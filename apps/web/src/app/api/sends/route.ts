/**
 * GET /api/sends — the send leaderboard as JSON (open-data ethos).
 * Query params: `grain` (1h|1d, default 1d), `scenario` (optional filter).
 */

import { NextResponse } from "next/server";
import { fetchSendBoard } from "@/lib/sends";

export const revalidate = 120;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const grain = url.searchParams.get("grain") === "1h" ? "1h" : "1d";
  const scenario = url.searchParams.get("scenario") ?? undefined;
  try {
    const rows = await fetchSendBoard(grain, scenario);
    return NextResponse.json({ grain, scenario: scenario ?? null, rows });
  } catch (err) {
    console.error("[api/sends]", (err as Error).message);
    return NextResponse.json({ error: "database temporarily unavailable" }, { status: 503 });
  }
}
