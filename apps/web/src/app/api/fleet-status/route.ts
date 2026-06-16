import { fetchProviderHealth } from "@/lib/health";
import { buildFleetSummary } from "@/lib/fleetStatus";

export const dynamic = "force-dynamic";

/**
 * Compact fleet summary for the header status pill (dot + hover tooltip).
 * fetchProviderHealth is cached 30s server-side, plus edge caching here, so N
 * polling clients converge to ~1 DB read / 30s.
 */
export async function GET() {
  try {
    const health = await fetchProviderHealth();
    return Response.json(
      buildFleetSummary(health),
      { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch {
    return new Response("fleet-status unavailable", { status: 503 });
  }
}
