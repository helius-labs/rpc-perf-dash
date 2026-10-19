/**
 * Two-lane read timeout (lib/boundedRead.ts) behind db().
 * Run: `node --import tsx --test src/lib/boundedRead.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedReader, isStatementTimeout } from "./boundedRead";

const timeoutErr = () =>
  Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
  });
const opts = { fastMs: 20, slowMs: 200, maxSlow: 1, knownSlowLimit: 2 };

/** A fake query that needs `needMs` of statement time (and takes real time,
 *  so the reader's "fit the fast budget" check sees it). */
function fakeDb(needMs: Record<string, number>) {
  const calls: Array<{ q: string; timeoutMs: number }> = [];
  const gates: Array<() => void> = [];
  const run = async (q: string, timeoutMs: number) => {
    calls.push({ q, timeoutMs });
    if (q.startsWith("gate")) await new Promise<void>((r) => gates.push(r));
    await new Promise((r) => setTimeout(r, Math.min(needMs[q] ?? 0, timeoutMs)));
    if ((needMs[q] ?? 0) > timeoutMs) throw timeoutErr();
    return `rows:${q}`;
  };
  return { run, calls, gates };
}

test("isStatementTimeout matches the wrapped 57014 timeout only", () => {
  assert.equal(isStatementTimeout(timeoutErr()), true);
  const adminCancel = Object.assign(new Error("x"), {
    cause: Object.assign(new Error("canceling statement due to user request"), { code: "57014" }),
  });
  assert.equal(isStatementTimeout(adminCancel), false);
  assert.equal(isStatementTimeout(new Error("boom")), false);
});

test("a fast read runs once on the fast lane", async () => {
  const f = fakeDb({ a: 2 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  assert.equal(await read("a"), "rows:a");
  assert.deepEqual(f.calls, [{ q: "a", timeoutMs: 20 }]);
});

test("a slow-but-valid read is retried on the slow lane and succeeds", async () => {
  const f = fakeDb({ s: 50 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  assert.equal(await read("s"), "rows:s");
  assert.deepEqual(f.calls.map((c) => c.timeoutMs), [20, 200]);
});

test("a known-slow read skips the fast attempt next time", async () => {
  const f = fakeDb({ s: 50 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  await read("s");
  f.calls.length = 0;
  await read("s");
  assert.deepEqual(f.calls.map((c) => c.timeoutMs), [200]);
});

test("a runaway read still fails at the slow cap", async () => {
  const f = fakeDb({ r: 500 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  await assert.rejects(read("r"), (e) => isStatementTimeout(e));
});

test("non-timeout errors are not retried", async () => {
  const read = createBoundedReader(async () => { throw new Error("syntax"); }, (q: string) => q, opts);
  await assert.rejects(read("x"), /syntax/);
});

test("slow lane full: the read fails with its fast timeout instead of queueing", async () => {
  const f = fakeDb({ gate1: 50, s2: 50 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  const first = read("gate1"); // fast attempt waits on the gate
  f.gates.shift()!();          // release fast attempt → timeout → takes the only slow slot
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(read("s2"), (e) => isStatementTimeout(e)); // lane busy → original error
  f.gates.shift()!();          // release the slow attempt
  assert.equal(await first, "rows:gate1");
});

test("concurrent identical slow reads share one slow-lane run", async () => {
  const f = fakeDb({ gate: 50 });
  const read = createBoundedReader(f.run, (q) => q, { ...opts, maxSlow: 5 });
  const a = read("gate");
  const b = read("gate");
  while (f.gates.length < 2) await new Promise((r) => setTimeout(r, 1));
  f.gates.splice(0).forEach((g) => g()); // both fast attempts time out
  while (f.gates.length < 1) await new Promise((r) => setTimeout(r, 1));
  f.gates.splice(0).forEach((g) => g());
  assert.deepEqual(await Promise.all([a, b]), ["rows:gate", "rows:gate"]);
  assert.equal(f.calls.filter((c) => c.timeoutMs === 200).length, 1);
});
