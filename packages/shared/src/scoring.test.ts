/**
 * Unit tests for the scalar region/method blenders that back the DISPLAYED win
 * rate (see docs/methodology.md § Scoring). These mirror the eligible-subset
 * renormalization of blendRegionScores/blendMethodScores but operate on a plain
 * scalar (a raw win rate) rather than a ScoredProvider.
 *
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blendRegionScalar,
  blendMethodScalar,
  DEFAULT_REGION_WEIGHTS,
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
