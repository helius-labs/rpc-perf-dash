import { NextResponse, type NextRequest } from "next/server";

/**
 * 404 for requests carrying HTML-escaped query keys (`amp;window`, `amp;bucket`,
 * …), before any page code or DB read runs.
 *
 * No browser sends these. They come from a scraper that copies hrefs out of raw
 * HTML without unescaping `&amp;` and keeps stacking params, so every request
 * is a new URL that no cache can absorb. On 2026-10-19 it walked /challenges
 * filter permutations at ~7 req/s and kept the DB saturated. The Vercel
 * Firewall rule "Block amp; param scraper" denies the same requests at the
 * edge; this is the in-app backstop if that rule is off or the scraper changes
 * which keys it mangles.
 */
export function middleware(req: NextRequest) {
  for (const key of req.nextUrl.searchParams.keys()) {
    if (key.startsWith("amp;")) {
      return new NextResponse("Not Found", {
        status: 404,
        headers: { "x-robots-tag": "noindex, nofollow" },
      });
    }
  }
  return NextResponse.next();
}

// Only routes that read query params. Next prepends basePath (/benchmarks) to
// these, and static assets never match.
export const config = {
  matcher: ["/", "/challenges", "/performance", "/provider/:path*", "/raw", "/run/:path*", "/api/:path*", "/embed/:path*"],
};
