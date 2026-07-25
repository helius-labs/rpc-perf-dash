/**
 * Precedence tests for loadEnv's merge core (mergeEnvFiles): the exact behavior
 * that once shipped inverted — `.env` beating `.env.local` — sending a stale
 * provider key to every fleet. Locks in: real env > .env.local > .env, plus
 * loud conflict detection. See docs/operations.md and env.ts.
 *
 * Run: `pnpm --filter @rpcbench/shared test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEnvFiles } from "./env.js";

// files are passed in load order: [.env, .env.local]
test("the later file (.env.local) overrides the earlier (.env)", () => {
  const { values } = mergeEnvFiles(new Set(), [
    { A: "from-env", B: "only-in-env" },
    { A: "from-local" },
  ]);
  assert.equal(values.A, "from-local");
  assert.equal(values.B, "only-in-env");
});

test("real environment wins over both files (never applied)", () => {
  const { values } = mergeEnvFiles(new Set(["A"]), [{ A: "from-env" }, { A: "from-local" }]);
  // A is a real-env key → excluded from the values to apply, so process.env keeps it.
  assert.equal(values.A, undefined);
});

test("a key with different values across files is reported as a conflict", () => {
  const { conflicts, values } = mergeEnvFiles(new Set(), [{ K: "one" }, { K: "two" }]);
  assert.deepEqual(conflicts, ["K"]);
  assert.equal(values.K, "two"); // still resolves to .env.local
});

test("same value in both files is NOT a conflict", () => {
  const { conflicts } = mergeEnvFiles(new Set(), [{ K: "x" }, { K: "x" }]);
  assert.deepEqual(conflicts, []);
});

test("a real-env key defined in a file is neither applied nor a conflict", () => {
  const { conflicts, values } = mergeEnvFiles(new Set(["K"]), [{ K: "a" }, { K: "b" }]);
  assert.deepEqual(conflicts, []);
  assert.equal(values.K, undefined);
});
