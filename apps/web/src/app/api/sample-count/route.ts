import { fetchSampleCount } from "@/lib/sampleCount";

export const dynamic = "force-dynamic";

/**
 * Live sample-count feed for the Overview counter. Server-cached 10s + edge
 * 10s/30s-SWR, so N polling clients converge to ~1 DB read / 10s.
 */
export async function GET() {
  try {
    const data = await fetchSampleCount();
    return Response.json(data, {
      headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" },
    });
  } catch {
    // Don't reset the client's counter on a transient failure — signal error
    // and let it keep extrapolating from the last good value.
    return new Response("sample-count unavailable", { status: 503 });
  }
}
