import type { MetadataRoute } from "next";
import { INDEXABLE_PATHS, canonicalUrl } from "@/lib/seo";

/**
 * Served at /benchmarks/sitemap.xml (Next prefixes it with the basePath).
 *
 * Declares exactly the allowlist in lib/seo.ts and nothing else — same constant
 * that drives the per-page robots tags, so the sitemap can't drift from what's
 * actually indexable. Lives outside the (site)/(embed) route groups because
 * sitemap.ts is a root-level file convention.
 *
 * NOTE there is deliberately no robots.ts beside it: under the helius.dev
 * reverse proxy it would emit at /benchmarks/robots.txt, which no crawler
 * reads — only helius.dev/robots.txt counts, and that lives in another repo
 * (which still needs a `Sitemap:` line pointing here).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return INDEXABLE_PATHS.map((path) => ({
    url: canonicalUrl(path),
    changeFrequency: "daily" as const,
    // The leaderboard is the entry point; the rest are equal supporting pages.
    priority: path === "/" ? 1 : 0.8,
  }));
}
