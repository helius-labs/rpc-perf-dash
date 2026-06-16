/**
 * Single source of truth for the share-link query encoding. Used by:
 *   - ShareButton (write)         — builds the tweet/download URLs
 *   - /og/leaderboard route (read) — renders the card from the same filters
 *   - generateMetadata (write)     — points twitter:image at the og route
 *
 * Keeping encode + decode here means the card always reflects the exact view
 * the sharer saw. Crucially the *weights* travel in the URL too: the Overview
 * re-ranks client-side with user-tuned weights, so without them the card would
 * disagree with the on-screen order (see docs/plan). No "use client" / no
 * server-only imports, so it runs in both the client button and the route.
 */

import { GEO_REGIONS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import {
  DEFAULT_WEIGHTS,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "./methods";
import { WINDOW_VALUES } from "./windows";
import { WORKLOAD_PRESETS, presetIdForWeights } from "./workloadPresets";

export type ShareRegion = GeoRegion | "overall";

export interface ShareFilters {
  method: Method;
  region: ShareRegion;
  mode: "cold" | "warm";
  windowHours: number;
  /** Cloud-infra vantage (worker_provider); omitted = pooled across all. */
  infra?: string | undefined;
  weights: ScoringWeights;
}

export const DEFAULT_SHARE_FILTERS: ShareFilters = {
  method: "getTransaction",
  region: "overall",
  mode: "cold",
  windowHours: 24,
  weights: DEFAULT_WEIGHTS,
};

const METHOD_SET: ReadonlySet<string> = new Set(ALL_METHODS);
const REGION_SET: ReadonlySet<string> = new Set(GEO_REGIONS);
const AXES: ReadonlyArray<keyof ScoringWeights> = [
  "latency",
  "winRate",
  "reliability",
  "correctness",
  "freshness",
];

/** Read a value from either a URLSearchParams or a plain record. */
function getParam(
  src: URLSearchParams | Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  const v = src[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Build the query string for a set of filters. Weights are encoded as
 * `preset=<id>` when they match a known persona preset, otherwise as a raw
 * `w=lat,win,rel,cor,fre` tuple at full precision (no rounding) so the card's
 * score ordering can't drift from the on-screen board. Default filters are
 * omitted to keep shared URLs clean.
 */
export function buildShareParams(filters: ShareFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.method !== DEFAULT_SHARE_FILTERS.method) p.set("method", filters.method);
  if (filters.region !== DEFAULT_SHARE_FILTERS.region) p.set("region", filters.region);
  if (filters.mode !== DEFAULT_SHARE_FILTERS.mode) p.set("mode", filters.mode);
  if (filters.windowHours !== DEFAULT_SHARE_FILTERS.windowHours)
    p.set("window", String(filters.windowHours));
  if (filters.infra) p.set("infra", filters.infra);

  const presetId = presetIdForWeights(filters.weights);
  const isDefault = AXES.every((a) => filters.weights[a] === DEFAULT_WEIGHTS[a]);
  if (presetId) {
    p.set("preset", presetId);
  } else if (!isDefault) {
    p.set("w", AXES.map((a) => filters.weights[a]).join(","));
  }
  return p;
}

/**
 * Relative path to the share-card image for a set of filters. Returned relative
 * so Next resolves it against `metadataBase` when used as an OG/twitter image,
 * and usable directly as a fetch target from the client.
 */
export function ogImagePath(filters: ShareFilters): string {
  const qs = buildShareParams(filters).toString();
  return `/og/leaderboard${qs ? `?${qs}` : ""}`;
}

/** Parse a raw `w=` tuple into weights, or null if malformed. */
function parseWeightTuple(raw: string): ScoringWeights | null {
  const parts = raw.split(",").map((s) => Number(s));
  if (parts.length !== AXES.length || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  const w = {} as ScoringWeights;
  AXES.forEach((a, i) => {
    w[a] = parts[i]!;
  });
  return w;
}

/**
 * Decode filters from a request's query params, clamping every field to its
 * canonical set and falling back to the high-signal defaults. Unknown / malformed
 * values never throw — the route always renders *something*.
 */
export function parseShareParams(
  src: URLSearchParams | Record<string, string | string[] | undefined>,
): ShareFilters {
  const methodRaw = getParam(src, "method");
  const method: Method = methodRaw && METHOD_SET.has(methodRaw)
    ? (methodRaw as Method)
    : DEFAULT_SHARE_FILTERS.method;

  const regionRaw = getParam(src, "region");
  const region: ShareRegion =
    regionRaw === "overall" || (regionRaw && REGION_SET.has(regionRaw))
      ? (regionRaw as ShareRegion)
      : DEFAULT_SHARE_FILTERS.region;

  const modeRaw = getParam(src, "mode");
  const mode: "cold" | "warm" = modeRaw === "warm" ? "warm" : "cold";

  const windowRaw = parseInt(getParam(src, "window") ?? "", 10);
  const windowHours = WINDOW_VALUES.has(windowRaw)
    ? windowRaw
    : DEFAULT_SHARE_FILTERS.windowHours;

  const infra = getParam(src, "infra") || undefined;

  let weights = DEFAULT_WEIGHTS;
  const presetId = getParam(src, "preset");
  const wRaw = getParam(src, "w");
  if (presetId) {
    const preset = WORKLOAD_PRESETS.find((p) => p.id === presetId);
    if (preset) weights = preset.weights;
  } else if (wRaw) {
    weights = parseWeightTuple(wRaw) ?? DEFAULT_WEIGHTS;
  }

  return { method, region, mode, windowHours, infra, weights };
}
