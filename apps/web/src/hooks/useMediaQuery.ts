"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe `matchMedia` hook. Returns `false` on the server and on the first
 * client render, then flips to the real value after the first effect runs.
 *
 * Callers (Tooltip, FloatingTooltip, LatencyChart) get the desktop branch on
 * SSR + the first paint, and switch to the touch / compact branch only after
 * hydration. A one-frame flash on first paint is acceptable here.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
