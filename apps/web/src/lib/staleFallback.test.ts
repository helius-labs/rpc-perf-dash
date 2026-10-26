/**
 * The per-provider stale fallback's pure parts: findProviderWindows (search
 * order, build sharing/budget), the coverage gate, the cube merge, and the
 * candidate list.
 * Run: `node --import tsx --test src/lib/staleFallback.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findProviderWindows,
  mergeProviderCubes,
  rankableProviders,
  staleCandidates,
  staleWindowHours,
  type StaleCandidate,
} from "./staleFallback";
import type { MethodGeoRows } from "@/components/leaderboardShared";

const c = (endAt: string, grain: StaleCandidate["grain"] = "1h"): StaleCandidate => ({ endAt, grain });

/** A "window" is the set of providers it ranks. */
async function run(
  candidates: Record<string, StaleCandidate[]>,
  ranksAt: Record<string, string[]>,
  maxBuilds = 4,
) {
  const builds: string[] = [];
  const errors: string[] = [];
  const found = await findProviderWindows<Set<string>>({
    providers: Object.keys(candidates),
    candidates: (id) => candidates[id] ?? [],
    build: async (cand) => {
      builds.push(`${cand.grain}|${cand.endAt}`);
      if (cand.endAt === "boom") throw new Error("boom");
      return new Set(ranksAt[cand.endAt] ?? []);
    },
    ranks: (w, id) => w.has(id),
    maxBuilds,
    onError: (stage) => errors.push(stage),
  });
  const picked = Object.fromEntries([...found].map(([id, w]) => [id, w.candidate.endAt]));
  return { picked, builds, errors };
}

test("each provider gets its own newest window that ranks it", async () => {
  const { picked } = await run(
    { helius: [c("t3"), c("t2")], triton: [c("t3"), c("t1")] },
    { t3: ["helius"], t1: ["triton"] },
  );
  assert.deepEqual(picked, { helius: "t3", triton: "t1" });
});

test("a window is built once and shared between providers", async () => {
  const { picked, builds } = await run(
    { helius: [c("d1", "1d")], chainstack: [c("d1", "1d")], quicknode: [c("d1", "1d")] },
    { d1: ["helius", "chainstack", "quicknode"] },
  );
  assert.deepEqual(picked, { helius: "d1", chainstack: "d1", quicknode: "d1" });
  assert.deepEqual(builds, ["1d|d1"]);
});

test("same end on different grains are different windows", async () => {
  const { builds } = await run({ helius: [c("t", "1h"), c("t", "1d")] }, { t: [] });
  assert.deepEqual(builds, ["1h|t", "1d|t"]);
});

test("the build cap stops new builds but already-built windows still serve", async () => {
  const { picked, builds } = await run(
    { a: [c("x"), c("y")], b: [c("z"), c("x")] },
    { x: ["b"], z: [] },
    2,
  );
  assert.deepEqual(builds, ["1h|x", "1h|y"]);
  assert.deepEqual(picked, { b: "x" });
});

test("a failed build is reported, counted, and skipped", async () => {
  const { picked, errors, builds } = await run({ a: [c("boom"), c("ok")], b: [c("boom")] }, { ok: ["a"] });
  assert.deepEqual(picked, { a: "ok" });
  assert.deepEqual(errors, ["build 1h|boom"]);
  assert.deepEqual(builds, ["1h|boom", "1h|ok"]);
});

test("a provider with no candidates is left out", async () => {
  const { picked, builds } = await run({ a: [] }, {});
  assert.deepEqual(picked, {});
  assert.deepEqual(builds, []);
});

type Row = MethodGeoRows["eligible"][number];
const row = (provider_id: string, tag = "") => ({ provider_id, tag }) as unknown as Row;
const cell = (method: string, geo: string, eligible: string[]): MethodGeoRows =>
  ({ method, geo, rows: [], eligible: eligible.map((id) => row(id)) }) as unknown as MethodGeoRows;
const ranked = (cube: MethodGeoRows[], min?: number) => [...rankableProviders(cube, min)].sort();

test("empty cube ranks nobody", () => {
  assert.deepEqual(ranked([]), []);
});

test("no eligible rows anywhere (consensus lost) ranks nobody", () => {
  const cube = ["a", "b", "c", "d", "e"].flatMap((m) => [cell(m, "na-east", []), cell(m, "eu-central", [])]);
  assert.deepEqual(ranked(cube), []);
});

test("a provider covering >= 60% of methods in any geo is rankable", () => {
  const cube = [
    cell("a", "na-east", ["helius"]),
    cell("b", "eu-central", ["helius"]),
    cell("c", "na-east", ["helius", "triton"]),
    cell("d", "na-east", []),
    cell("e", "na-east", []),
  ];
  assert.deepEqual(ranked(cube), ["helius"]);
});

test("coverage is per provider, not summed across providers", () => {
  const cube = [
    cell("a", "na-east", ["helius"]),
    cell("b", "na-east", ["helius"]),
    cell("c", "na-east", ["chainstack"]),
    cell("d", "na-east", ["chainstack"]),
    cell("e", "na-east", []),
  ];
  assert.deepEqual(ranked(cube), []);
});

test("the same method in two geos counts once", () => {
  const cube = [
    cell("a", "na-east", ["helius"]),
    cell("a", "eu-central", ["helius"]),
    cell("b", "na-east", []),
  ];
  assert.deepEqual(ranked(cube, 0.6), []);
  assert.deepEqual(ranked(cube, 0.5), ["helius"]);
});

const full = (method: string, geo: string, ids: string[], tag: string, eligible = ids): MethodGeoRows =>
  ({
    method,
    geo,
    rows: ids.map((id) => row(id, tag)),
    eligible: eligible.map((id) => row(id, tag)),
  }) as unknown as MethodGeoRows;
const tags = (rows: Row[]) => rows.map((r) => `${r.provider_id}:${(r as unknown as { tag: string }).tag}`).sort();

test("merge swaps only the stale providers' rows, cell by cell", () => {
  const live = [
    full("a", "na-east", ["helius", "triton"], "live", ["helius"]),
    full("b", "na-east", ["helius", "triton"], "live", ["helius"]),
  ];
  const tritonWindow = [
    full("a", "na-east", ["helius", "triton"], "oct15"),
    full("b", "na-east", ["helius", "triton"], "oct15", ["helius"]),
  ];
  const merged = mergeProviderCubes(live, new Map([["triton", tritonWindow]]));

  assert.deepEqual(tags(merged[0]!.rows), ["helius:live", "triton:oct15"]);
  assert.deepEqual(tags(merged[0]!.eligible), ["helius:live", "triton:oct15"]);
  // Not eligible in its own window's cell → not eligible after the merge either.
  assert.deepEqual(tags(merged[1]!.eligible), ["helius:live"]);
});

test("merge drops a stale provider from cells its window doesn't have", () => {
  const live = [full("a", "na-east", ["helius", "triton"], "live"), full("a", "eu-central", ["helius", "triton"], "live")];
  const merged = mergeProviderCubes(live, new Map([["triton", [full("a", "na-east", ["triton"], "old")]]]));
  assert.deepEqual(tags(merged[1]!.rows), ["helius:live"]);
  assert.equal(merged.length, 2);
});

test("merge with no stale providers returns the live cube", () => {
  const live = [cell("a", "na-east", ["helius"])];
  assert.equal(mergeProviderCubes(live, new Map()), live);
});

const hourly = [
  { provider_id: "alchemy", endAt: "h3" },
  { provider_id: "alchemy", endAt: "h2" },
  { provider_id: "alchemy", endAt: "h1" },
  { provider_id: "helius", endAt: "hx" },
];
const daily = [
  { provider_id: "alchemy", endAt: "d2" },
  { provider_id: "alchemy", endAt: "d1" },
];

test("candidates: up to 2 hourly ends, then up to 2 daily ends", () => {
  assert.deepEqual(staleCandidates("alchemy", 24, hourly, daily), [
    { endAt: "h3", grain: "1h" },
    { endAt: "h2", grain: "1h" },
    { endAt: "d2", grain: "1d" },
    { endAt: "d1", grain: "1d" },
  ]);
  assert.deepEqual(staleCandidates("triton", 24, hourly, daily), []);
});

test("candidates: windows read off the 1d grain only get daily ends", () => {
  assert.deepEqual(staleCandidates("alchemy", 720, hourly, daily), [
    { endAt: "d2", grain: "1d" },
    { endAt: "d1", grain: "1d" },
  ]);
});

test("a daily window covers whole days", () => {
  assert.equal(staleWindowHours(1, "1d"), 24);
  assert.equal(staleWindowHours(24, "1d"), 24);
  assert.equal(staleWindowHours(168, "1d"), 168);
  assert.equal(staleWindowHours(6, "1h"), 6);
});
