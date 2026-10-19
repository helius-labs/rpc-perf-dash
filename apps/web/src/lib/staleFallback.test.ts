/**
 * Search order for the stale leaderboard fallback (lib/staleFallback.ts).
 * Run: `node --import tsx --test src/lib/staleFallback.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findRankableWindow, type StaleCandidate } from "./staleFallback";

const recent = (n: number, good: boolean): StaleCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ endAt: `recent-${i + 1}`, good }));

/** Two passes (48h, 8d) over fixed candidate lists; `rankable` endAts rank. */
function harness(passes: StaleCandidate[][], rankable: string[], maxProbes = 3) {
  const fetched: number[] = [];
  const probed: string[] = [];
  const run = () =>
    findRankableWindow({
      passes: passes.length,
      fetchPass: async (pass) => {
        fetched.push(pass);
        const c = passes[pass];
        if (c === undefined) throw new Error(`pass ${pass} failed`);
        return c;
      },
      probe: async (endAt) => {
        probed.push(endAt);
        return rankable.includes(endAt) ? endAt : null;
      },
      maxProbes,
    });
  return { run, fetched, probed };
}

test("three recent unrankable ends plus an older rankable end: finds the older one", async () => {
  // Bert's case: the 48h pass offers three healthy-looking windows that can't
  // rank; the rankable window only shows up in the 8-day pass.
  const h = harness([recent(3, true), [{ endAt: "older", good: true }]], ["older"]);
  assert.equal(await h.run(), "older");
  assert.deepEqual(h.probed, ["recent-1", "recent-2", "older"]);
  assert.ok(h.probed.length <= 3);
});

test("same case when the recent windows are recovery blips (not good)", async () => {
  const h = harness([recent(3, false), [{ endAt: "older", good: true }]], ["older"]);
  assert.equal(await h.run(), "older");
  assert.deepEqual(h.probed, ["older"]); // blips aren't probed ahead of a good window
});

test("an older window that isn't 'good' still gets the reserved probe", async () => {
  const h = harness([recent(3, true), [{ endAt: "older", good: false }]], ["older"]);
  assert.equal(await h.run(), "older");
  assert.deepEqual(h.probed, ["recent-1", "recent-2", "older"]);
});

test("a rankable recent window wins without querying the wider pass", async () => {
  const h = harness([[{ endAt: "recent-1", good: true }], [{ endAt: "older", good: true }]], ["recent-1"]);
  assert.equal(await h.run(), "recent-1");
  assert.deepEqual(h.fetched, [0]);
});

test("unused budget goes back to candidates a pass couldn't afford", async () => {
  // The 8-day pass has nothing, so the third recent window gets the spare probe.
  const h = harness([recent(3, true), []], ["recent-3"]);
  assert.equal(await h.run(), "recent-3");
  assert.deepEqual(h.probed, ["recent-1", "recent-2", "recent-3"]);
});

test("a failed narrow-pass lookup doesn't stop the wider pass", async () => {
  const passes = [undefined as unknown as StaleCandidate[], [{ endAt: "older", good: true }]];
  const errors: string[] = [];
  const result = await findRankableWindow({
    passes: 2,
    fetchPass: async (pass) => {
      if (pass === 0) throw new Error("timeout");
      return passes[pass]!;
    },
    probe: async (endAt) => endAt,
    maxProbes: 3,
    onError: (stage) => errors.push(stage),
  });
  assert.equal(result, "older");
  assert.deepEqual(errors, ["pass 0"]);
});

test("a probe that throws is skipped, not fatal", async () => {
  const result = await findRankableWindow({
    passes: 1,
    fetchPass: async () => recent(2, true),
    probe: async (endAt) => {
      if (endAt === "recent-1") throw new Error("cube timeout");
      return endAt;
    },
    maxProbes: 3,
  });
  assert.equal(result, "recent-2");
});

test("never probes more than maxProbes or the same window twice", async () => {
  const h = harness([recent(4, true), [...recent(2, true), { endAt: "older", good: false }]], []);
  assert.equal(await h.run(), null);
  assert.equal(h.probed.length, 3);
  assert.equal(new Set(h.probed).size, h.probed.length);
});
