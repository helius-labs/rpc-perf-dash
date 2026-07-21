/**
 * Single source of truth for the share-link query encoding. Used by:
 *   - ShareButton (write)         — builds the tweet/download URLs
 *   - /og/leaderboard route (read) — renders the card from the same filters
 *   - generateMetadata (write)     — points twitter:image at the og route
 *
 * Both the homepage board and the /performance ScoreStrip are the same
 * `buildPresetLeaderRows` blend, so a share fully describes that board: a
 * starting preset plus overrides for the method set, per-method weights, the
 * region subset, and the component weights. The OG route reconstructs the exact
 * board via `fetchRankedPreset(effective filters)`. Defaults (anything equal to
 * the preset) are omitted to keep URLs clean. No "use client" / no server-only
 * imports, so it runs in both the client button and the route.
 */

import { GEO_REGIONS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import {
  DEFAULT_WEIGHTS,
  type MethodWeights,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { ALL_METHODS } from "./methods";
import { siteUrl } from "./siteUrl";
import { WINDOW_VALUES } from "./windows";
import {
  DEFAULT_PRESET_ID,
  SCORE_PRESETS,
  equalMethodWeights,
  methodWeightsFor,
  presetById,
  type PresetId,
} from "./workloadPresets";

export interface ShareFilters {
  /** Starting preset — gives the label + defaults the overrides are diffed against. */
  presetId: PresetId;
  /** Effective method set blended into the board. */
  methods: readonly Method[];
  /** Effective per-method weights. */
  methodWeights: MethodWeights;
  /** Effective region subset (weights come from DEFAULT_REGION_WEIGHTS). */
  regions: readonly GeoRegion[];
  /** Component (L/W/R/C/F) weights. */
  weights: ScoringWeights;
  mode: "cold" | "warm";
  windowHours: number;
  /** Cloud-infra vantage (worker_provider); omitted = pooled across all. */
  infra?: string | undefined;
}

const BALANCED = presetById(DEFAULT_PRESET_ID);

export const DEFAULT_SHARE_FILTERS: ShareFilters = {
  presetId: DEFAULT_PRESET_ID,
  methods: BALANCED.methods,
  methodWeights: methodWeightsFor(BALANCED),
  regions: Object.keys(BALANCED.regionWeights) as GeoRegion[],
  weights: DEFAULT_WEIGHTS,
  mode: "cold",
  windowHours: 24,
};

const PRESET_IDS: ReadonlySet<string> = new Set(SCORE_PRESETS.map((p) => p.id));
const METHOD_SET: ReadonlySet<string> = new Set(ALL_METHODS);
const REGION_SET: ReadonlySet<string> = new Set<string>(GEO_REGIONS);
const AXES: ReadonlyArray<keyof ScoringWeights> = [
  "latency",
  "winRate",
  "reliability",
  "correctness",
  "freshness",
];
const WEIGHT_EPS = 1e-6;

/** Read a value from either a URLSearchParams or a plain record. */
function getParam(
  src: URLSearchParams | Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  if (src instanceof URLSearchParams) return src.get(key) ?? undefined;
  const v = src[key];
  return Array.isArray(v) ? v[0] : v;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

/**
 * Build the share query string. Encodes only what differs from the starting
 * preset; the presence of `methods=` is the discriminator between a custom/
 * performance board and a plain preset board.
 */
export function buildShareParams(filters: ShareFilters): URLSearchParams {
  const p = new URLSearchParams();
  const preset = presetById(filters.presetId);

  if (filters.presetId !== DEFAULT_PRESET_ID) p.set("preset", filters.presetId);

  const methodsOverridden = !sameSet(filters.methods, preset.methods);
  if (methodsOverridden) p.set("methods", filters.methods.join(","));

  // Per-method weights diffed against the base the decoder reconstructs without
  // `mw` (even over the effective methods, or the preset's). Sparse → only the
  // tuned ones travel.
  const base = methodsOverridden ? equalMethodWeights(filters.methods) : methodWeightsFor(preset);
  const mw = filters.methods
    .filter((m) => Math.abs((filters.methodWeights[m] ?? 0) - (base[m] ?? 0)) > WEIGHT_EPS)
    .map((m) => `${m}:${filters.methodWeights[m]}`);
  if (mw.length > 0) p.set("mw", mw.join(","));

  if (!sameSet(filters.regions, Object.keys(preset.regionWeights))) {
    p.set("regions", filters.regions.join(","));
  }

  const weightsDefault = AXES.every((a) => filters.weights[a] === DEFAULT_WEIGHTS[a]);
  if (!weightsDefault) p.set("w", AXES.map((a) => filters.weights[a]).join(","));

  if (filters.mode !== DEFAULT_SHARE_FILTERS.mode) p.set("mode", filters.mode);
  if (filters.windowHours !== DEFAULT_SHARE_FILTERS.windowHours)
    p.set("window", String(filters.windowHours));
  if (filters.infra) p.set("infra", filters.infra);
  return p;
}

/**
 * Absolute URL to the share-card image for a set of filters. Built off
 * `siteUrl()` (which includes the /benchmarks basePath in prod) rather than
 * returned relative: a root-relative "/og/leaderboard" resolved against a
 * `metadataBase` that carries a path — `new URL("/og/…", ".../benchmarks")` —
 * drops the /benchmarks segment, so social scrapers would fetch a 404. An
 * absolute URL is used verbatim by Next for OG/Twitter images. Mirrors how the
 * page canonicals are constructed from `siteUrl()`.
 */
export function ogImagePath(filters: ShareFilters): string {
  const qs = buildShareParams(filters).toString();
  return `${siteUrl()}/og/leaderboard${qs ? `?${qs}` : ""}`;
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
 * canonical set and falling back to the preset defaults. Unknown / malformed
 * values never throw — the route always renders *something*.
 *
 * Legacy single `method=` / `region=<geo>` links are still accepted (aliased to
 * the new list forms) so previously-shared URLs keep working.
 */
export function parseShareParams(
  src: URLSearchParams | Record<string, string | string[] | undefined>,
): ShareFilters {
  const presetRaw = getParam(src, "preset");
  const presetId: PresetId = presetRaw && PRESET_IDS.has(presetRaw)
    ? (presetRaw as PresetId)
    : DEFAULT_PRESET_ID;
  const preset = presetById(presetId);

  // Methods: `methods=` list, else legacy singular `method=`, else the preset's.
  const methodsRaw = getParam(src, "methods") ?? getParam(src, "method");
  const parsedMethods = methodsRaw
    ? methodsRaw.split(",").map((s) => s.trim()).filter((s): s is Method => METHOD_SET.has(s))
    : [];
  const methodsOverridden = parsedMethods.length > 0;
  const methods: readonly Method[] = methodsOverridden ? parsedMethods : preset.methods;

  // Method weights: base over the EFFECTIVE methods, then sparse `mw` overrides.
  const methodWeights: MethodWeights = methodsOverridden
    ? equalMethodWeights(methods)
    : { ...methodWeightsFor(preset) };
  const mwRaw = getParam(src, "mw");
  if (mwRaw) {
    for (const pair of mwRaw.split(",")) {
      const [m, wStr] = pair.split(":");
      const w = Number(wStr);
      if (m && METHOD_SET.has(m) && Number.isFinite(w) && w >= 0) methodWeights[m] = w;
    }
  }

  // Regions: `regions=` list, else the preset's region subset.
  const regionsRaw = getParam(src, "regions");
  let regions: readonly GeoRegion[];
  if (regionsRaw) {
    const parsed = regionsRaw
      .split(",").map((s) => s.trim()).filter((s): s is GeoRegion => REGION_SET.has(s));
    regions = parsed.length > 0 ? parsed : (Object.keys(preset.regionWeights) as GeoRegion[]);
  } else {
    regions = Object.keys(preset.regionWeights) as GeoRegion[];
  }

  const wRaw = getParam(src, "w");
  const weights = wRaw ? (parseWeightTuple(wRaw) ?? preset.weights) : preset.weights;

  const modeRaw = getParam(src, "mode");
  const mode: "cold" | "warm" = modeRaw === "warm" ? "warm" : "cold";

  const windowRaw = parseInt(getParam(src, "window") ?? "", 10);
  const windowHours = WINDOW_VALUES.has(windowRaw) ? windowRaw : DEFAULT_SHARE_FILTERS.windowHours;

  const infra = getParam(src, "infra") || undefined;

  return { presetId, methods, methodWeights, regions, weights, mode, windowHours, infra };
}
