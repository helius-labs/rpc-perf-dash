/**
 * Shared route-level loading skeleton. Rendered by each route's `loading.tsx`
 * so navigation paints an instant pulsing placeholder while the (force-dynamic)
 * server render runs / streams — instead of a blank screen. Matches the dark
 * theme tokens used elsewhere (`bg-surface`, `border-line`).
 *
 * `Skeleton` is the primitive block; `PageLoading` is a generic
 * header-plus-content layout that reads as "a page is loading" on every route.
 */

import type { CSSProperties } from "react";

/** A single pulsing placeholder block. */
export function Skeleton({
  width = "100%",
  height = 16,
  className = "",
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-surface border border-line ${className}`}
      style={{ width, height, ...style }}
    />
  );
}

/**
 * Generic page skeleton: a kicker + title block, then a few rows of content.
 * `rows` controls how many content bars to draw (default 6).
 */
export function PageLoading({ rows = 6 }: { rows?: number } = {}) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ marginTop: 12 }}>
      <Skeleton width={120} height={11} style={{ marginBottom: 14 }} />
      <Skeleton width="46%" height={34} style={{ marginBottom: 28 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} height={44} />
        ))}
      </div>
    </div>
  );
}
