/**
 * Unit tests for the head-to-head (A-vs-B) win-rate math (see
 * docs/methodology.md § Head-to-head win rate). Guards the site-consistency
 * invariant: "Overall" is a DEFAULT_REGION_WEIGHTS region blend of per-geo raw
 * rates, NOT a traffic-weighted sum — matching every other Overall on the site.
 *
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHeadToHead, type PairwiseGeoRow } from "./headToHead.js";
import { blendRegionScalar, DEFAULT_REGION_WEIGHTS } from "./scoring.js";

const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test("single geo → passthrough of that geo's raw rate a/(a+b)", () => {
  // na-east only: 6 of 10 contested won by a → 0.6, regardless of geo weight.
  const rows: PairwiseGeoRow[] = [{ geo: "na-east", a_wins: 6, b_wins: 4, n_contested: 10 }];
  const r = computeHeadToHead(rows);
  approx(r.a_win_rate!, 0.6);
  approx(r.b_win_rate!, 0.4);
  assert.equal(r.a_wins, 6);
  assert.equal(r.b_wins, 4);
  assert.equal(r.n_contested, 10);
});

test("overall = DEFAULT_REGION_WEIGHTS blend, NOT the volume-weighted sum", () => {
  // na-east: a dominates on huge volume (0.9). eu-central: a loses on tiny
  // volume (0.2). Both geos carry equal region weight (0.35), so the blend is
  // ~mid; a naive volume-weighted sum would be dragged toward 0.9.
  const rows: PairwiseGeoRow[] = [
    { geo: "na-east", a_wins: 900, b_wins: 100, n_contested: 1000 },
    { geo: "eu-central", a_wins: 2, b_wins: 8, n_contested: 10 },
  ];
  const r = computeHeadToHead(rows);
  const expected = blendRegionScalar(
    new Map([
      ["na-east", 0.9],
      ["eu-central", 0.2],
    ]),
    DEFAULT_REGION_WEIGHTS,
  )!; // (0.35*0.9 + 0.35*0.2) / 0.7 = 0.55
  approx(r.a_win_rate!, expected);
  approx(r.a_win_rate!, 0.55);
  // b is the exact complement of the blended a (same present geos both sides).
  approx(r.a_win_rate! + r.b_win_rate!, 1);
  // raw counts are the plain sums (transparency), distinct from the rate.
  assert.equal(r.a_wins, 902);
  assert.equal(r.n_contested, 1010);
});

test("geos with zero contested don't enter the blend", () => {
  const rows: PairwiseGeoRow[] = [
    { geo: "na-east", a_wins: 3, b_wins: 1, n_contested: 4 },
    { geo: "na-west", a_wins: 0, b_wins: 0, n_contested: 0 },
  ];
  const r = computeHeadToHead(rows);
  // Only na-east present → passthrough 0.75.
  approx(r.a_win_rate!, 0.75);
});

test("no contested challenges → null rates", () => {
  assert.deepEqual(computeHeadToHead([]), {
    a_win_rate: null,
    b_win_rate: null,
    a_wins: 0,
    b_wins: 0,
    n_contested: 0,
  });
  const allZero: PairwiseGeoRow[] = [{ geo: "na-east", a_wins: 0, b_wins: 0, n_contested: 0 }];
  const r = computeHeadToHead(allZero);
  assert.equal(r.a_win_rate, null);
  assert.equal(r.b_win_rate, null);
});
