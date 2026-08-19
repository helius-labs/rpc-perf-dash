/**
 * Unit tests for the region/method blenders behind the leaderboards
 * (see docs/methodology.md § Scoring):
 *
 *   - the SCALAR blenders that back the displayed win rate — they mirror
 *     blendRegionScores/blendMethodScores' eligible-subset renormalization but
 *     operate on a plain number rather than a ScoredProvider;
 *   - blendRegionScores' sub-score mode, which the score-breakdown tooltips
 *     print to the user (see the section comment further down).
 *
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blendRegionScalar,
  blendMethodScalar,
  blendRegionScores,
  DEFAULT_REGION_WEIGHTS,
  DEFAULT_WEIGHTS,
  type ScoredProvider,
} from "./scoring.js";
import { type GeoRegion } from "./types.js";

const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("blendRegionScalar: full region set → weight-dot-product (weights sum to 1)", () => {
  // rate 1.0 in na-east only; everything else 0. Result = na-east weight (0.35).
  const m = new Map<GeoRegion, number>([
    ["na-east", 1],
    ["eu-central", 0],
    ["ap-northeast", 0],
    ["na-west", 0],
    ["eu-west", 0],
    ["ap-southeast", 0],
  ]);
  approx(blendRegionScalar(m, DEFAULT_REGION_WEIGHTS)!, 0.35);
});

test("blendRegionScalar: renormalizes over only the present regions", () => {
  // Present in na-east + eu-central (0.35 each). wSum = 0.7; renormalized mean.
  const m = new Map<GeoRegion, number>([
    ["na-east", 0.4],
    ["eu-central", 0.2],
  ]);
  // (0.35*0.4 + 0.35*0.2) / 0.7 = 0.3
  approx(blendRegionScalar(m, DEFAULT_REGION_WEIGHTS)!, 0.3);
});

test("blendRegionScalar: empty map → null", () => {
  assert.equal(blendRegionScalar(new Map(), DEFAULT_REGION_WEIGHTS), null);
});

test("blendRegionScalar: region weighting sinks a low-weight-region specialist", () => {
  // The mechanism behind the reported inversion (Alchemy vs QuickNode on
  // getTransaction). A wins big ONLY in na-west (weight 0.05); B wins steadily in
  // the two 0.35-weighted regions. Region-weighting must rank B above A, even
  // though A's single-region win rate (1.0) dwarfs any of B's.
  // Both present in all six regions (wSum = 1) so the blend is a clean dot product.
  const a = new Map<GeoRegion, number>([
    ["na-east", 0],
    ["eu-central", 0],
    ["ap-northeast", 0],
    ["na-west", 1.0],
    ["eu-west", 0],
    ["ap-southeast", 0],
  ]);
  const b = new Map<GeoRegion, number>([
    ["na-east", 0.3],
    ["eu-central", 0.3],
    ["ap-northeast", 0],
    ["na-west", 0],
    ["eu-west", 0],
    ["ap-southeast", 0],
  ]);
  const scoreA = blendRegionScalar(a, DEFAULT_REGION_WEIGHTS)!; // 0.05*1.0 = 0.05
  const scoreB = blendRegionScalar(b, DEFAULT_REGION_WEIGHTS)!; // 0.35*0.3+0.35*0.3 = 0.21
  approx(scoreA, 0.05);
  approx(scoreB, 0.21);
  assert.ok(scoreB > scoreA, "region-weighted rank must favor the heavy-region winner");
});

test("blendMethodScalar: equal weights → simple mean; empty → null", () => {
  const m = new Map<string, number>([
    ["getBlock", 0.2],
    ["getSlot", 0.4],
  ]);
  approx(blendMethodScalar(m, { getBlock: 1, getSlot: 1 })!, 0.3);
  approx(blendMethodScalar(m, { getBlock: 3, getSlot: 1 })!, 0.25); // (0.6+0.4)/4
  assert.equal(blendMethodScalar(new Map(), { getBlock: 1 }), null);
});

test("blendMethodScalar: a method absent from the weights (or ≤0) is excluded", () => {
  const m = new Map<string, number>([
    ["a", 0.5],
    ["b", 0.9],
  ]);
  // Only 'a' carries weight → result is 'a' alone.
  approx(blendMethodScalar(m, { a: 1 })!, 0.5);
  // Negative weight clamps to 0 → excluded.
  approx(blendMethodScalar(m, { a: 1, b: -5 })!, 0.5);
});

// ---------------------------------------------------------------------------
// blendRegionScores({ subs: true }) — the invariant the score-breakdown
// tooltips rest on: the five sub-scores × their weights must still add up to
// the blended `total`. Both the Overview's method-blend pipeline and the
// /performance strip print that arithmetic to the user, so a blend that moved
// `total` and the subs by different weights would render a formula that
// visibly doesn't compute.
// ---------------------------------------------------------------------------

/** A ScoredProvider whose total is the exact weighted sum of its sub-scores. */
function scored(
  provider_id: string,
  subs: {
    latency: number;
    winRate: number;
    reliability: number;
    correctness: number;
    freshness: number;
  },
): ScoredProvider {
  const w = DEFAULT_WEIGHTS;
  return {
    provider_id,
    total:
      w.latency * subs.latency +
      w.winRate * subs.winRate +
      w.reliability * subs.reliability +
      w.correctness * subs.correctness +
      w.freshness * subs.freshness,
    ...subs,
  };
}

const dot = (s: ScoredProvider) =>
  DEFAULT_WEIGHTS.latency * s.latency +
  DEFAULT_WEIGHTS.winRate * s.winRate +
  DEFAULT_WEIGHTS.reliability * s.reliability +
  DEFAULT_WEIGHTS.correctness * s.correctness +
  DEFAULT_WEIGHTS.freshness * s.freshness;

test("blendRegionScores({subs:true}): blended subs still dot-product to blended total", () => {
  const a = (l: number, w: number, r: number, c: number, f: number) => [
    scored("a", { latency: l, winRate: w, reliability: r, correctness: c, freshness: f }),
  ];
  const perRegion = new Map<GeoRegion, readonly ScoredProvider[]>([
    ["na-east", a(90, 70, 99, 100, 100)],
    ["eu-central", a(60, 20, 97, 99, 80)],
    ["ap-northeast", a(40, 5, 95, 98, 60)],
  ]);
  const [blended] = blendRegionScores(perRegion, DEFAULT_REGION_WEIGHTS, { subs: true });
  assert.ok(blended);
  approx(dot(blended!), blended!.total);
  // Eligible-subset renormalization: present in 0.35/0.35/0.15 → wSum 0.85.
  const w = { "na-east": 0.35 / 0.85, "eu-central": 0.35 / 0.85, "ap-northeast": 0.15 / 0.85 };
  approx(blended!.latency, 90 * w["na-east"] + 60 * w["eu-central"] + 40 * w["ap-northeast"]);
});

test("blendRegionScores: without opts.subs the sub-scores come back 0", () => {
  // Why /performance's mini board had to opt in — its strip prints the subs, and
  // the default blend deliberately leaves them unset (total only).
  const perRegion = new Map<GeoRegion, readonly ScoredProvider[]>([
    [
      "na-east",
      [scored("a", { latency: 90, winRate: 70, reliability: 99, correctness: 100, freshness: 1 })],
    ],
  ]);
  const [plain] = blendRegionScores(perRegion, DEFAULT_REGION_WEIGHTS);
  assert.ok(plain!.total > 0);
  assert.equal(plain!.latency, 0);
  assert.equal(plain!.freshness, 0);
});
