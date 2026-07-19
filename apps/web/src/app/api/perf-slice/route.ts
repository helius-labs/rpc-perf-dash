/**
 * Lazy per-infra data for the /performance PerfExplorer. Returns BOTH connection
 * modes for the requested infra so the client's cold/warm toggle stays instant
 * after an infra switch. The heavy fetchers underneath are the same
 * `unstable_cache`d ones the page uses, so this shares their cache — it doesn't
 * add new query shapes. Client-only helper; not part of the public API surface.
 */
import { NextResponse } from "next/server";
import { GEO_REGIONS, type GeoRegion, type Method } from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { fetchActiveGeos } from "@/lib/leaderboard";
import { buildPerfSlice } from "@/lib/perfSlice";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;

  const geoSet = new Set<string>(GEO_REGIONS);
  const selectedGeos = (sp.get("geos") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is GeoRegion => geoSet.has(s));

  const methodSet = new Set<string>(ALL_METHODS);
  const methods = (sp.get("methods") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Method => methodSet.has(s));
  if (methods.length === 0) methods.push("getTransaction" as Method);

  const w = parseInt(sp.get("window") ?? "", 10);
  const windowHours = WINDOWS.some((x) => x.value === w) ? w : 24;

  // `infra` absent or "all" → pooled.
  const infraRaw = sp.get("infra");
  const infra = !infraRaw || infraRaw === "all" ? null : infraRaw;

  try {
    const activeGeos = await fetchActiveGeos();
    const [cold, warm] = await Promise.all([
      buildPerfSlice({ infra, mode: "cold", activeGeos, selectedGeos, methods, windowHours }),
      buildPerfSlice({ infra, mode: "warm", activeGeos, selectedGeos, methods, windowHours }),
    ]);
    return NextResponse.json(
      { cold, warm },
      // Short CDN cache so repeated first-switches across clients coalesce.
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" } },
    );
  } catch (err) {
    console.error("[/api/perf-slice]", err);
    return NextResponse.json({ error: DB_ERROR_MESSAGE }, { status: 503 });
  }
}
