/**
 * Single source of truth for the /embed/* widget URLs and their paste-ready
 * <iframe> snippet. Used by:
 *   - ExportButtons (client)      — the "Embed URL" / "Embed iframe" menu items
 *   - EmbedWidgetCard (docs)      — the /api-reference § Embeds code panels
 *
 * Keeping both on one builder means the string a user copies out of the chart
 * dropdown is byte-identical to the one documented on /api-reference.
 *
 * No "use client" and no server-only imports, so it runs in both places. The
 * origin is always an ARGUMENT rather than something resolved in here: the docs
 * card is SSR'd and must use a server-supplied origin (a `window` lookup during
 * its render would hydrate-mismatch on the very string it is printing), while
 * the dropdown resolves the live origin at click time via clientEmbedOrigin().
 */

import { BASE_PATH } from "./basePath";

/** The widget routes under /embed — keep in sync with app/(embed)/embed/*. */
export type EmbedWidget = "chart" | "latency-table" | "leaderboard" | "score";

/**
 * Client-side origin for an embed URL, e.g. "https://www.helius.dev/benchmarks".
 * Derived from the live location so the copied link is correct under BOTH the
 * helius.dev reverse proxy and the raw *.vercel.app origin, without depending on
 * NEXT_PUBLIC_SITE_URL being set. `siteUrl()` returns a BARE origin with no
 * basePath, which is why the prefix is added here rather than assumed.
 *
 * Call this inside an event handler only — never during render.
 */
export function clientEmbedOrigin(): string {
  return `${window.location.origin}${BASE_PATH}`;
}

/**
 * `${origin}/embed/${widget}?${qs}`. Empty/undefined values are dropped, so
 * callers can pass their whole filter set and let defaults fall away — a
 * default view yields a bare URL with no query string. Key order follows
 * insertion order of `params`, so callers control it and the output is stable.
 *
 * Commas are emitted literally (`providers=helius,alchemy`, not `%2C`). They're
 * legal unencoded in a query string and every reader here splits on "," — and
 * these URLs exist to be read and pasted by humans, so the escaping would be
 * pure noise. URLSearchParams has no option for this, hence the post-pass.
 */
export function buildEmbedUrl(
  origin: string,
  widget: EmbedWidget,
  params: Record<string, string | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, v);
  }
  const q = qs.toString().replace(/%2C/g, ",");
  return `${origin}/embed/${widget}${q ? `?${q}` : ""}`;
}

/** The ready-to-paste iframe snippet for an embed URL. */
export function embedIframeSnippet(url: string, title: string): string {
  return `<iframe
  src="${url}"
  title="${title}"
  style="width:100%;border:0"
  scrolling="no"
  loading="lazy"
></iframe>`;
}
