/**
 * Executable form of the worked-examples table in consensus.ts and the
 * scoring formulas in scoring.ts (§ Scoring in docs/methodology.md). If a
 * rule change breaks one of these, the methodology doc needs a paired update.
 *
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideConsensus, type Voter } from "./consensus.js";
import { score, DEFAULT_WEIGHTS, type ProviderMetrics } from "./scoring.js";

/** Voter whose projection hash is the single byte `group` — voters sharing a
 * group byte are byte-equal and land in the same agreement group. */
function voter(id: string, group: number): Voter<string> {
  return { id, projection: { hash: new Uint8Array([group]), shape: null }, response: id };
}

/** Build a panel from group sizes: panel(3, 2) → 3 voters agreeing on one
 * answer + 2 agreeing on another. */
function panel(...groupSizes: number[]): Voter<string>[] {
  return groupSizes.flatMap((size, g) =>
    Array.from({ length: size }, (_, i) => voter(`g${g}v${i}`, g)),
  );
}

test("n=5 split 5-0 → consensus, no dissenters", () => {
  const out = decideConsensus(panel(5));
  assert.equal(out.kind, "consensus");
  assert.equal(out.kind === "consensus" && out.majority_ids.length, 5);
  assert.equal(out.kind === "consensus" && out.dissenter_ids.length, 0);
});

test("n=5 split 4-1 → consensus with 1 dissenter", () => {
  const out = decideConsensus(panel(4, 1));
  assert.equal(out.kind, "consensus");
  assert.deepEqual(out.kind === "consensus" && [...out.dissenter_ids], ["g1v0"]);
});

test("n=5 split 3-2 → consensus with 2 dissenters", () => {
  const out = decideConsensus(panel(3, 2));
  assert.equal(out.kind, "consensus");
  assert.equal(out.kind === "consensus" && out.majority_ids.length, 3);
  assert.equal(out.kind === "consensus" && out.dissenter_ids.length, 2);
});

test("n=5 split 2-2-1 → ambiguous (largest group below the 3-member floor)", () => {
  const out = decideConsensus(panel(2, 2, 1));
  assert.equal(out.kind, "ambiguous");
});

test("n=4 split 3-1 → consensus (3 agree, 1 doesn't → the 3 are correct)", () => {
  const out = decideConsensus(panel(3, 1));
  assert.equal(out.kind, "consensus");
  assert.equal(out.kind === "consensus" && out.majority_ids.length, 3);
});

test("n=4 split 2-2 → ambiguous (no strict majority)", () => {
  assert.equal(decideConsensus(panel(2, 2)).kind, "ambiguous");
});

test("n=6 split 3-3 → ambiguous (g > n/2 must be strict)", () => {
  assert.equal(decideConsensus(panel(3, 3)).kind, "ambiguous");
});

test("n=3 split 3-0 → consensus", () => {
  assert.equal(decideConsensus(panel(3)).kind, "consensus");
});

test("n=3 split 2-1 → ambiguous under the default floor", () => {
  assert.equal(decideConsensus(panel(2, 1)).kind, "ambiguous");
});

test("n=3 split 2-1 with minGroup=2 (3-voter structural panel) → consensus", () => {
  const out = decideConsensus(panel(2, 1), undefined, { minGroup: 2 });
  assert.equal(out.kind, "consensus");
  assert.equal(out.kind === "consensus" && out.dissenter_ids.length, 1);
});

test("n=2 → ambiguous (below MIN_CONSENSUS_VOTERS)", () => {
  assert.equal(decideConsensus(panel(2)).kind, "ambiguous");
});

test("consensus reference comes from the majority group", () => {
  const out = decideConsensus(panel(3, 2));
  assert.ok(out.kind === "consensus" && out.majority_ids.includes("g0v0"));
  assert.equal(out.kind === "consensus" && out.reference_response, "g0v0");
});

// ── Scoring ────────────────────────────────────────────────────────────

function metrics(over: Partial<ProviderMetrics> & { provider_id: string }): ProviderMetrics {
  return {
    p50_latency_ms: 100,
    p95_latency_ms: 200,
    success_rate: 1,
    correct_count: 100,
    validated_count: 100,
    freshness_p95_lag: 0,
    n_wins: 0,
    n_challenges_with_winner: 0,
    ...over,
  };
}

test("headline weights sum to 1 (0.25 L + 0.25 W + 0.25 R + 0.20 C + 0.05 F)", () => {
  const sum =
    DEFAULT_WEIGHTS.latency +
    DEFAULT_WEIGHTS.winRate +
    DEFAULT_WEIGHTS.reliability +
    DEFAULT_WEIGHTS.correctness +
    DEFAULT_WEIGHTS.freshness;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("best provider pins every component (and the total) to 100", () => {
  const [a] = score([
    metrics({ provider_id: "a", n_wins: 8, n_challenges_with_winner: 10 }),
    metrics({
      provider_id: "b",
      p50_latency_ms: 200,
      p95_latency_ms: 400,
      success_rate: 0.9,
      correct_count: 80,
      freshness_p95_lag: 10,
      n_wins: 2,
      n_challenges_with_winner: 10,
    }),
  ]);
  assert.deepEqual(
    { L: a!.latency, W: a!.winRate, R: a!.reliability, C: a!.correctness, F: a!.freshness, total: a!.total },
    { L: 100, W: 100, R: 100, C: 100, F: 100, total: 100 },
  );
});

test("component math matches the documented formulas exactly", () => {
  const [, b] = score([
    metrics({ provider_id: "a", n_wins: 8, n_challenges_with_winner: 10 }),
    metrics({
      provider_id: "b",
      p50_latency_ms: 200, // best/`b` = 0.5 → L_p50 = 50
      p95_latency_ms: 400, // best/`b` = 0.5 → L_p95 = 50
      success_rate: 0.9, //                     R = 90
      correct_count: 80, //  80/100            C = 80
      freshness_p95_lag: 10, // best lag 0 →   F = (1/10)*100 = 10
      n_wins: 2,
      n_challenges_with_winner: 10, // 0.2/0.8 → W = 25
    }),
  ]);
  assert.equal(b!.latency, 50);
  assert.equal(b!.winRate, 25);
  assert.equal(b!.reliability, 90);
  assert.equal(b!.correctness, 80);
  assert.equal(b!.freshness, 10);
  // 0.25·50 + 0.25·25 + 0.25·90 + 0.20·80 + 0.05·10 = 57.75
  assert.ok(Math.abs(b!.total - 57.75) < 1e-9);
});

test("degenerate win rate (nobody ever wins) → W=100 for everyone", () => {
  const scored = score([metrics({ provider_id: "a" }), metrics({ provider_id: "b" })]);
  assert.ok(scored.every((s) => s.winRate === 100));
});

test("zero validated samples → C=0, not NaN", () => {
  const [a] = score([metrics({ provider_id: "a", correct_count: 0, validated_count: 0 })]);
  assert.equal(a!.correctness, 0);
  assert.ok(Number.isFinite(a!.total));
});
