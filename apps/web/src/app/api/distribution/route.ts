/**
 * GET /api/distribution
 *
 * Latency-distribution series (CDF / histogram / box) for one method×mode×window
 * ×geo×infra, read lazily by the Performance page's "Latency distribution"
 * metric. Hits the raw `samples` table, so it is intentionally NOT fetched on
 * normal page loads — only when a user selects the distribution metric.
 *
 * Query params (mirrors the Performance page filters):
 *   method  — RPC method (default getTransaction)
 *   mode    — cold | warm (default cold)
 *   hours   — window: 1 | 6 | 24 | 168 | 720 (default 24). All windows are fast
 *             now that this reads the precomputed latency_histogram_* tables.
 *   region  — GEO (na-east, eu-central, …); omitted/invalid = Overall (all geos)
 *   wp      — infra (worker_provider); omitted/"all" = pooled across clouds
 *
 * NOTE: `region` here is a GEO, not a raw cloud region.
 */
import { GEO_REGIONS, type GeoRegion, type Method } from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { fetchLatencyDistribution } from "@/lib/distribution";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;

  const methodRaw = sp.get("method") ?? "getTransaction";
  const method: Method = (ALL_METHODS as readonly string[]).includes(methodRaw)
    ? (methodRaw as Method)
    : "getTransaction";

  const connectionMode = sp.get("mode") === "warm" ? "warm" : "cold";

  const hoursRaw = parseInt(sp.get("hours") ?? "", 10);
  const windowHours = WINDOWS.some((w) => w.value === hoursRaw) ? hoursRaw : 24;

  const regionRaw = sp.get("region") ?? "";
  const geo: GeoRegion | null = (GEO_REGIONS as readonly string[]).includes(regionRaw)
    ? (regionRaw as GeoRegion)
    : null;

  const wpRaw = sp.get("wp") ?? "all";
  const workerProvider = wpRaw === "all" || wpRaw === "" ? undefined : wpRaw;

  try {
    const result = await fetchLatencyDistribution({
      method,
      connectionMode,
      windowHours,
      geo,
      workerProvider,
    });
    return new Response(JSON.stringify(result), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch (e) {
    console.error("[/api/distribution]", e);
    return new Response(JSON.stringify({ error: DB_ERROR_MESSAGE }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
}
