/**
 * GET /api/recent-challenges?limit=20
 *
 * Read-only JSON feed for the home-page table's client-side polling
 * (RecentChallengesTable). Returns the same shape as the SSR fetcher.
 *
 * Caching strategy:
 *   - 10s server-side cache (unstable_cache, shared with the SSR call) so
 *     N concurrent polling clients = 1 DB query / 10s, not N queries.
 *   - 5s CDN cache (s-maxage) so most requests don't even hit the function.
 *     `stale-while-revalidate` extends the freshness window without
 *     blocking clients on a re-fetch.
 *
 * No auth — same public data the dashboard renders.
 */

import { fetchRecentChallenges } from "@/lib/recentChallenges";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(1, limitParam), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const rows = await fetchRecentChallenges(limit);
  return new Response(JSON.stringify(rows), {
    headers: {
      "content-type": "application/json",
      // Edge CDN caches for 5s; SWR returns stale data for up to 30s while
      // revalidating in the background.
      "cache-control": "public, s-maxage=5, stale-while-revalidate=30",
    },
  });
}
