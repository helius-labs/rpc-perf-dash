/**
 * singleFlight collapses concurrent identical fetches (the /challenges stampede guard).
 * Run: `node --import tsx --test src/lib/singleFlight.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "./singleFlight";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test("concurrent calls with the same key share one run", async () => {
  let runs = 0;
  const d = deferred<number>();
  const fn = () => (runs++, d.promise);
  const a = singleFlight("k", fn);
  const b = singleFlight("k", fn);
  d.resolve(42);
  assert.deepEqual(await Promise.all([a, b]), [42, 42]);
  assert.equal(runs, 1);
});

test("different keys run independently", async () => {
  let runs = 0;
  const fn = async () => ++runs;
  await Promise.all([singleFlight("x", fn), singleFlight("y", fn)]);
  assert.equal(runs, 2);
});

test("a settled call is not reused", async () => {
  let runs = 0;
  const fn = async () => ++runs;
  assert.equal(await singleFlight("z", fn), 1);
  assert.equal(await singleFlight("z", fn), 2);
});

test("a rejection reaches every waiter and clears the key", async () => {
  const d = deferred<number>();
  const a = singleFlight("e", () => d.promise);
  const b = singleFlight("e", () => d.promise);
  d.reject(new Error("boom"));
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(await singleFlight("e", async () => 7), 7);
});
