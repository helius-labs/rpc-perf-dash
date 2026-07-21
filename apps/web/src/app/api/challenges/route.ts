/**
 * GET /api/challenges?method=&bucket=&status=&window=&target=&offset=
 *
 * Read-only JSON feed for the /challenges table's client-side polling
 * (ChallengesTable). Param parsing and the row query are shared with the
 * page's SSR fetch (lib/challengeRows.ts), so the poll returns exactly the
 * slice the page rendered.
 *
 * Caching: 10s server-side cache (unstable_cache, shared with the SSR call) +
 * 5s CDN cache with stale-while-revalidate, so N polling clients converge to
 * ~1 DB query / 10s per filter set.
 *
 * No auth — same public data the page renders.
 */

import { fetchChallengeRows } from "@/lib/challengeRows";
import { parseChallengesFilters } from "@/lib/challengeFilters";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filters = parseChallengesFilters({
    method: url.searchParams.get("method") ?? undefined,
    bucket: url.searchParams.get("bucket") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    window: url.searchParams.get("window") ?? undefined,
    target: url.searchParams.get("target") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });

  const rows = await fetchChallengeRows(filters);
  return new Response(JSON.stringify(rows), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=5, stale-while-revalidate=30",
    },
  });
}
