/**
 * Run: `pnpm --filter @rpcbench/methods test` (node:test via tsx).
 *
 * Fix 4: the projection must cap to the top-20 holders BY AMOUNT before hashing,
 * so a provider returning up to 100 accounts (QuickNode) still hashes equal to a
 * provider returning the spec'd 20 — as long as the largest-20 agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "./getTokenLargestAccounts.js";

// Build a `{ context, value:[{address, amount}] }` response.
const resp = (entries: Array<[string, number]>) => ({
  context: { slot: 1 },
  value: entries.map(([address, amount]) => ({
    address,
    amount: String(amount),
    decimals: 0,
    uiAmount: amount,
    uiAmountString: String(amount),
  })),
});

// Deterministic 20 "largest" holders + 80 dust holders.
const top20: Array<[string, number]> = Array.from({ length: 20 }, (_, i) => [
  `top${String(i).padStart(3, "0")}`,
  1_000_000 - i * 1_000,
]);
const dust80: Array<[string, number]> = Array.from({ length: 80 }, (_, i) => [
  `dust${String(i).padStart(3, "0")}`,
  100 - (i % 50),
]);

test("gTLA: 100-account response hashes equal to the 20-account response (same top-20)", () => {
  const twenty = handlers.project(resp(top20));
  // Panel-style 20. QuickNode-style 100 = the same 20 largest + 80 dust, shuffled.
  const hundred = handlers.project(resp([...dust80, ...top20].reverse()));
  assert.deepEqual(hundred.hash, twenty.hash);
});

test("gTLA: a genuinely different top-20 does NOT hash equal", () => {
  const a = handlers.project(resp(top20));
  const different = top20.map(([, amt], i) => [`other${i}`, amt] as [string, number]);
  const b = handlers.project(resp(different));
  assert.notDeepEqual(a.hash, b.hash);
});
