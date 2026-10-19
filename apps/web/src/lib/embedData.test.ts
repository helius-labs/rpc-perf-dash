/**
 * isCubeRankable gates the stale-leaderboard fallback in buildOverviewBoardData.
 * Run: `node --import tsx --test src/lib/embedData.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCubeRankable } from "./embedData";
import type { MethodGeoRows } from "@/components/leaderboardShared";

const row = (provider_id: string) => ({ provider_id }) as MethodGeoRows["eligible"][number];
const cell = (method: string, geo: string, eligible: string[]): MethodGeoRows =>
  ({ method, geo, rows: [], eligible: eligible.map(row) }) as unknown as MethodGeoRows;

test("empty cube is not rankable", () => {
  assert.equal(isCubeRankable([]), false);
});

test("no eligible rows anywhere (consensus lost) is not rankable", () => {
  const cube = ["a", "b", "c", "d", "e"].flatMap((m) => [cell(m, "na-east", []), cell(m, "eu-central", [])]);
  assert.equal(isCubeRankable(cube), false);
});

test("a provider covering >= 60% of methods in any geo makes it rankable", () => {
  const cube = [
    cell("a", "na-east", ["helius"]),
    cell("b", "eu-central", ["helius"]),
    cell("c", "na-east", ["helius"]),
    cell("d", "na-east", []),
    cell("e", "na-east", []),
  ];
  assert.equal(isCubeRankable(cube), true);
});

test("coverage below the gate is not rankable, even summed across providers", () => {
  // 2/5 methods each — the gate is per provider, not panel-wide.
  const cube = [
    cell("a", "na-east", ["helius"]),
    cell("b", "na-east", ["helius"]),
    cell("c", "na-east", ["chainstack"]),
    cell("d", "na-east", ["chainstack"]),
    cell("e", "na-east", []),
  ];
  assert.equal(isCubeRankable(cube), false);
});

test("the same method in two geos counts once", () => {
  const cube = [
    cell("a", "na-east", ["helius"]),
    cell("a", "eu-central", ["helius"]),
    cell("b", "na-east", []),
  ];
  assert.equal(isCubeRankable(cube, 0.6), false);
  assert.equal(isCubeRankable(cube, 0.5), true);
});
