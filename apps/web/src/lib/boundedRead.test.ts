/**
 * Two-lane read timeout (lib/boundedRead.ts) behind db().
 * Run: `node --import tsx --test src/lib/boundedRead.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedReader, isStatementTimeout, ReadBudgetExhausted } from "./boundedRead";

const timeoutErr = () =>
  Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
  });
const opts = { fastMs: 20, slowMs: 200, maxSlow: 1, knownSlowLimit: 2, giveUpMs: 1000, minReadMs: 5 };

const tick = () => new Promise((r) => setTimeout(r, 1));
const until = async (cond: () => boolean) => {
  while (!cond()) await tick();
};

/** A fake query that needs `needMs` of statement time (and takes real time,
 *  so the reader's "fit the fast budget" check sees it). Queries named
 *  "gate*" also wait for the test to release them. */
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

test("a slow-lane run that turns out fast is not remembered as slow", async () => {
  const needMs = { s: 50 };
  const f = fakeDb(needMs);
  const read = createBoundedReader(f.run, (q) => q, opts);
  await read("s"); // fast timeout → slow lane, remembered
  needMs.s = 2; // the DB got quiet
  await read("s"); // slow lane, finishes under fastMs → forgotten
  f.calls.length = 0;
  await read("s");
  assert.deepEqual(f.calls.map((c) => c.timeoutMs), [20]);
});

test("a runaway read still fails at the slow cap", async () => {
  const f = fakeDb({ r: 500 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  await assert.rejects(read("r"), (e) => isStatementTimeout(e));
});

test("after a slow-lane timeout the query isn't escalated again until giveUpMs passes", async () => {
  let clock = 0;
  const f = fakeDb({ r: 500 });
  const read = createBoundedReader(f.run, (q) => q, { ...opts, now: () => clock });
  await assert.rejects(read("r"), (e) => isStatementTimeout(e)); // fast + slow
  f.calls.length = 0;
  await assert.rejects(read("r"), (e) => isStatementTimeout(e)); // fast only
  assert.deepEqual(f.calls.map((c) => c.timeoutMs), [20]);
  clock += 1001;
  f.calls.length = 0;
  await assert.rejects(read("r"), (e) => isStatementTimeout(e)); // escalates again
  assert.deepEqual(f.calls.map((c) => c.timeoutMs), [20, 200]);
});

test("non-timeout errors are not retried", async () => {
  const read = createBoundedReader(async () => { throw new Error("syntax"); }, (q: string) => q, opts);
  await assert.rejects(read("x"), /syntax/);
});

test("slow lane full: the read fails with its fast timeout instead of queueing", async () => {
  const f = fakeDb({ gate1: 50, s2: 50 });
  const read = createBoundedReader(f.run, (q) => q, opts);
  const first = read("gate1");
  await until(() => f.gates.length === 1);
  f.gates.shift()!(); // fast attempt times out → takes the only slow slot
  await until(() => f.gates.length === 1); // slow attempt is now holding the slot
  await assert.rejects(read("s2"), (e) => isStatementTimeout(e));
  f.gates.shift()!();
  assert.equal(await first, "rows:gate1");
});

test("concurrent identical slow reads share one slow-lane run", async () => {
  const f = fakeDb({ gate: 50 });
  const read = createBoundedReader(f.run, (q) => q, { ...opts, maxSlow: 5 });
  const a = read("gate");
  const b = read("gate");
  await until(() => f.gates.length === 2);
  f.gates.splice(0).forEach((g) => g()); // both fast attempts time out
  await until(() => f.gates.length === 1);
  f.gates.splice(0).forEach((g) => g());
  assert.deepEqual(await Promise.all([a, b]), ["rows:gate", "rows:gate"]);
  assert.equal(f.calls.filter((c) => c.timeoutMs === 200).length, 1);
});

test("request budget: both lanes are clipped to the time left", async () => {
  const f = fakeDb({ s: 50 });
  const read = createBoundedReader(f.run, (q) => q, { ...opts, remainingMs: () => 120 });
  await read("s");
  assert.deepEqual(f.calls.map((c) => c.timeoutMs), [20, 120]);
});

test("request budget: no slow retry when less than fastMs is left", async () => {
  const deadline = Date.now() + 30;
  const f = fakeDb({ s: 50 });
  const read = createBoundedReader(f.run, (q) => q, { ...opts, remainingMs: () => deadline - Date.now() });
  // Fast attempt gets ~20ms and times out with ~10ms left: not enough to escalate.
  await assert.rejects(read("s"), (e) => isStatementTimeout(e));
  assert.equal(f.calls.length, 1);
});

test("request budget: a read with nothing left fails without touching the DB", async () => {
  const f = fakeDb({ a: 2 });
  const read = createBoundedReader(f.run, (q) => q, { ...opts, remainingMs: () => 2 });
  await assert.rejects(read("a"), ReadBudgetExhausted);
  assert.equal(f.calls.length, 0);
});

test("a request joining a slow-lane run waits only its own budget", async () => {
  const f = fakeDb({ gate: 50 });
  let budget: number | undefined;
  const read = createBoundedReader(f.run, (q) => q, { ...opts, maxSlow: 5, remainingMs: () => budget });
  // Make "gate" known-slow: fast attempt times out, slow lane succeeds.
  const warm = read("gate");
  await until(() => f.gates.length === 1);
  f.gates.shift()!();
  await until(() => f.gates.length === 1);
  f.gates.shift()!();
  assert.equal(await warm, "rows:gate");
  // Request A (no budget) starts the slow-lane run and holds it open.
  const a = read("gate");
  await until(() => f.gates.length === 1);
  // Request B has 25ms left: it joins A's run but must give up at its budget.
  budget = 25;
  const startedB = Date.now();
  await assert.rejects(read("gate"), ReadBudgetExhausted);
  assert.ok(Date.now() - startedB < 150, "B gave up at its own budget");
  budget = undefined;
  f.gates.shift()!();
  assert.equal(await a, "rows:gate");
});
