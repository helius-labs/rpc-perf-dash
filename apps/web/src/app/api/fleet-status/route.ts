import { fetchProviderHealth } from "@/lib/health";
import { gradeFleet } from "@/lib/fleetStatus";

export const dynamic = "force-dynamic";

/**
 * Headline fleet status for the header dot. fetchProviderHealth is cached 30s
 * server-side, plus edge caching here, so N polling clients converge to
 * ~1 DB read / 30s.
 */
export async function GET() {
  try {
    const health = await fetchProviderHealth();
    return Response.json(
      { status: gradeFleet(health.infra) },
      { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch {
    return new Response("fleet-status unavailable", { status: 503 });
  }
}
