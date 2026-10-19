/**
 * `rel` for an in-app link: "nofollow" when the URL carries a query string.
 *
 * Every filter control on /challenges and /performance renders as a real link,
 * and those pages have enough filter params (bucket × status × method × window
 * × offset …) that following them is an effectively unbounded crawl. Each
 * crawled URL is a unique, uncached render with its own heavy DB reads; on
 * 2026-10-19 a crawler walking ?bucket=…&status=… combinations at ~7 req/s kept
 * the database saturated. Filtered views are already noindex (lib/seo.ts), so
 * there is nothing to gain from crawling them. Clean paths keep a normal rel.
 *
 * Dependency-free so client components (FilterPill, MethodFilter) can use it.
 */
export function filterLinkRel(href: string): "nofollow" | undefined {
  return href.includes("?") ? "nofollow" : undefined;
}
