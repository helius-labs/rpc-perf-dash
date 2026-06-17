/**
 * Workload presets for the Overview leaderboard.
 *
 * A preset is a full workload definition, not just a weight vector: it bundles
 * the RPC method set + per-method weights, the geo-region subset, and the
 * L/W/R/C/F component weights. The Overview blends a provider's scores across
 * the preset's methods (method-blend) and regions (region-blend) into one
 * headline score; users can tune both the component weights and the per-method
 * weights on top of the preset starting point.
 *
 *   Balanced — every scored method, equal weight; all six geos; default
 *              component weights. The neutral "show me everything" view.
 *   Trading  — latency / win-rate focused; the methods a trading path hits
 *              (blockhash, slot, account reads); the three primary trading geos
 *              (na-east, eu-central, ap-northeast).
 *   Apps     — reliability / correctness focused; the read methods app backends
 *              lean on; all six geos.
 *
 * NOTE: weight vectors are starting points, not measured optima — tune them if
 * a preset doesn't rank the way its label promises. `sendTransaction` is NOT a
 * scored method (it's a broadcast with no correctness/honeypot to validate), so
 * it deliberately isn't in any preset's method set.
 */

import {
  DEFAULT_REGION_WEIGHTS,
  type MethodWeights,
  type RegionWeights,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import type { Method } from "@rpcbench/shared";
import { ALL_METHODS } from "./methods";

export type PresetId = "balanced" | "trading" | "apps";

export interface ScorePreset {
  id: PresetId;
  label: string;
  /** Compact label for the on-page chips (so all presets fit one line on mobile). */
  short: string;
  /** One-line plain-language summary of what the workload optimizes for. */
  caption: string;
  /** L/W/R/C/F component weights (sum to 1.0). */
  weights: ScoringWeights;
  /** The methods blended into the score. */
  methods: readonly Method[];
  /** Per-method weights; omitted ⇒ equal weight across `methods`. */
  methodWeights?: MethodWeights;
  /** Geo subset (+ relative weights) blended into the score. */
  regionWeights: Partial<RegionWeights>;
}

/** Trading hits the three primary geos; reuse the default relative weights
 *  (renormalized by blendRegionScores over just these three). */
const TRADING_REGION_WEIGHTS: Partial<RegionWeights> = {
  "na-east": DEFAULT_REGION_WEIGHTS["na-east"],
  "eu-central": DEFAULT_REGION_WEIGHTS["eu-central"],
  "ap-northeast": DEFAULT_REGION_WEIGHTS["ap-northeast"],
};

export const SCORE_PRESETS: readonly ScorePreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    short: "Balanced",
    caption: "Every method weighted evenly across all regions — the neutral overall view.",
    weights: { latency: 0.25, winRate: 0.25, reliability: 0.25, correctness: 0.2, freshness: 0.05 },
    methods: ALL_METHODS,
    regionWeights: DEFAULT_REGION_WEIGHTS,
  },
  {
    id: "trading",
    label: "Trading",
    short: "Trading",
    caption: "Speed-first: lowest latency and most often the fastest correct answer, in the primary trading regions.",
    weights: { latency: 0.4, winRate: 0.3, reliability: 0.1, correctness: 0.05, freshness: 0.15 },
    methods: ["getLatestBlockhash", "getSlot", "getAccountInfo", "getProgramAccounts"],
    regionWeights: TRADING_REGION_WEIGHTS,
  },
  {
    id: "apps",
    label: "Apps",
    short: "Apps",
    caption: "Reliability-first: accurate, always-landing reads across all regions.",
    weights: { latency: 0.15, winRate: 0.05, reliability: 0.45, correctness: 0.3, freshness: 0.05 },
    methods: [
      "getTransaction",
      "getSignaturesForAddress",
      "getProgramAccounts",
      "getTokenAccountsByOwner",
      "getAccountInfo",
      "getMultipleAccounts",
    ],
    regionWeights: DEFAULT_REGION_WEIGHTS,
  },
] as const;

export const DEFAULT_PRESET_ID: PresetId = "balanced";

export function presetById(id: string | null | undefined): ScorePreset {
  return SCORE_PRESETS.find((p) => p.id === id) ?? SCORE_PRESETS[0]!;
}

const PRESET_IDS: ReadonlySet<string> = new Set(SCORE_PRESETS.map((p) => p.id));

export function isPresetId(id: string | null | undefined): id is PresetId {
  return id != null && PRESET_IDS.has(id);
}

/** Equal weight across the given methods (the default when a preset doesn't
 *  pin per-method weights, and the reset target for the method-weight panel). */
export function equalMethodWeights(methods: readonly Method[]): MethodWeights {
  if (methods.length === 0) return {};
  const w = 1 / methods.length;
  const out: MethodWeights = {};
  for (const m of methods) out[m] = w;
  return out;
}

/** Resolve a preset's effective per-method weights (explicit, else equal). */
export function methodWeightsFor(preset: ScorePreset): MethodWeights {
  return preset.methodWeights ?? equalMethodWeights(preset.methods);
}
