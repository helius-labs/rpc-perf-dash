/**
 * Crawl/index policy for the whole app — one allowlist, one canonical builder.
 *
 * Google was indexing every filter permutation under /benchmarks (?bucket=,
 * ?window=, ?board=, ?method=, ?offset=…). Each one is a distinct URL over
 * near-duplicate content, which burns crawl budget and splits ranking signals
 * away from the handful of pages that should actually rank.
 *
 * The policy is default-DENY: `(site)/layout.tsx` sets `robots: NOINDEX`, and
 * Next merges metadata parent→child per field, so any page that doesn't set
 * `robots` inherits it. Indexable pages opt in explicitly via `pageSeo()`.
 * That way a new route is noindex until someone deliberately adds it here,
 * rather than silently joining the index.
 */

import type { Metadata } from "next";
import { BENCHMARKED_PROVIDERS, providerSlug } from "@rpcbench/shared";
import { BASE_PATH } from "./basePath";
import { siteUrl } from "./siteUrl";

/**
 * Every URL allowed into the index, as app-absolute paths (no basePath — that's
 * `canonicalUrl`'s job). Provider pages are derived from the shared registry so
 * adding a provider updates both this allowlist and the sitemap for free.
 *
 * Anything not listed here is noindex, including /performance, /runs, /raw,
 * /status and /run/[id] — real pages, just not ones we want competing in
 * search with the five above.
 */
export const INDEXABLE_PATHS: readonly string[] = [
  "/",
  "/sends",
  "/challenges",
  "/methodology",
  "/changelog",
  ...BENCHMARKED_PROVIDERS.map((p) => `/provider/${providerSlug(p)}`),
];

/**
 * Absolute origin INCLUDING the basePath, e.g.
 * "https://www.helius.dev/benchmarks".
 *
 * `siteUrl()` is whatever NEXT_PUBLIC_SITE_URL says, and that var is set on
 * Production ONLY — where it already carries /benchmarks. On Preview and local
 * `siteUrl()` falls back to a BARE origin (VERCEL_URL / localhost) with no
 * basePath, and a canonical built off that points at a 404. So append the
 * basePath only when it's missing; both branches are live in practice.
 */
export function canonicalOrigin(): string {
  const base = siteUrl();
  return base.endsWith(BASE_PATH) ? base : base + BASE_PATH;
}

/**
 * Absolute canonical URL for an app-absolute path. "/" collapses to the bare
 * origin (no trailing slash) so it matches the URL Google already has indexed.
 */
export function canonicalUrl(path: string): string {
  return path === "/" ? canonicalOrigin() : `${canonicalOrigin()}${path}`;
}

export const INDEX: Metadata["robots"] = { index: true, follow: true };

/**
 * `follow: true` on purpose — unlike /api-reference and the embeds, which are
 * deliberate dead ends. A filtered view still links to the clean pages we DO
 * want crawled; dropping follow would strand those links.
 */
export const NOINDEX: Metadata["robots"] = { index: false, follow: true };

/**
 * True if the request carried any query string at all.
 *
 * Typed `object`, not `Record<string, string | undefined>`: pages declare their
 * params as an `interface`, and TS gives implicit index signatures only to type
 * aliases — a Record parameter would force an `as` cast at every call site
 * (which is exactly why the `parseShareParams` calls already carry one).
 *
 * Deliberately keyed on ANY param rather than a known filter list, so
 * ?utm_source=… and future filters need no edit here. Values can be `string[]`
 * at runtime for repeated keys (?window=1&window=6) despite the declared
 * `string | undefined`, hence the array branch.
 */
export function hasQuery(params: object): boolean {
  return Object.values(params).some((v) =>
    Array.isArray(v) ? v.some(Boolean) : Boolean(v),
  );
}

/**
 * The robots + canonical pair for a page. Spread into a `Metadata` return.
 *
 * The canonical is ALWAYS the clean path, so a parameterized URL points home.
 * Pass `params` on routes that read searchParams; omit it on routes that don't
 * (they can never be parameterized into a duplicate).
 *
 * Note the parameterized case emits noindex AND a canonical to a different URL
 * — a combination Google's docs call contradictory. Accepted deliberately: the
 * clean targets are self-canonical and explicitly index:true, so nothing points
 * *at* a noindexed URL and there's no cluster for the noindex to propagate
 * through.
 */
export function pageSeo(
  path: string,
  params?: object,
): Pick<Metadata, "robots" | "alternates"> {
  return {
    robots: params && hasQuery(params) ? NOINDEX : INDEX,
    alternates: { canonical: canonicalUrl(path) },
  };
}
