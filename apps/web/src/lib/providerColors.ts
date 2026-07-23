/**
 * Single source of truth for provider colors used in charts + UI accents.
 * Future provider additions extend FIXED_COLORS; the fallback hashes to a
 * deterministic HSL hue so additions don't break charts before they're
 * explicitly themed.
 */

import { apiPath } from "./basePath";

const FIXED_COLORS: Record<string, string> = {
  helius: "#c2410c",            // dark orange
  triton: "#a78bfa",            // purple
  quicknode: "#4ade80",         // green
  alchemy: "#3aa3ff",           // blue
  chainstack: "#ffc200",        // yellow, from Chainstack's secondary palette (distinct from alchemy's blue on chart; official brand color is blue, see BRAND_COLORS below)
};

// Official brand colors, used to tint the #1 provider's name/rank on the
// leaderboard. Keyed by provider id.
const BRAND_COLORS: Record<string, string> = {
  quicknode: "#6CFF75",
  helius: "#E84125",
  alchemy: "#363FF9",
  triton: "#A12CFF",
  chainstack: "#007BFF",
};

/** Brand color for a provider, or null if it has no defined brand color. */
export function brandColorFor(providerId: string): string | null {
  return BRAND_COLORS[providerId] ?? null;
}

// Brand logo marks, served from /public/logos. Paths are basePath-prefixed at
// the accessor (apiPath) — public/ assets move under the basePath, and these are
// consumed by plain <img>/<iframe>/OG-route fetch, none of which Next
// auto-prefixes.
const LOGOS: Record<string, string> = {
  helius: "/logos/helius.svg",
  quicknode: "/logos/quicknode.svg",
  alchemy: "/logos/alchemy.svg",
  triton: "/logos/triton.svg",
  chainstack: "/logos/chainstack.svg",
};

/** Path to a provider's logo mark, or null if none. */
export function logoFor(providerId: string): string | null {
  const path = LOGOS[providerId];
  return path ? apiPath(path) : null;
}

// Animated (canvas/JS "dot animation") logo marks, embedded via <iframe>.
const ANIMATED_LOGOS: Record<string, string> = {
  helius: "/logos/animated/helius.html",
  quicknode: "/logos/animated/quicknode.html",
  alchemy: "/logos/animated/alchemy.html",
  triton: "/logos/animated/triton.html",
};

/** Path to a provider's animated logo page, or null if none. */
export function animatedLogoFor(providerId: string): string | null {
  const path = ANIMATED_LOGOS[providerId];
  return path ? apiPath(path) : null;
}

export function colorFor(providerId: string): string {
  const fixed = FIXED_COLORS[providerId];
  if (fixed) return fixed;
  // Fallback: hash → HSL hue, fixed S/L for legibility on dark bg.
  let h = 0;
  for (let i = 0; i < providerId.length; i++) {
    h = (h * 31 + providerId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 65%, 60%)`;
}
