/**
 * Counting plan for the /status timeline job (planTimeline): which hours get a
 * full count, which get an incremental add, and the watermark math.
 * Run: `node --import tsx --test src/statusTimeline.test.ts` from apps/generator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOUR_MS,
  TIMELINE_LAG_MS,
  TIMELINE_SETTLE_MS,
  TIMELINE_WINDOW_HOURS,
  planTimeline,
  type TimelineAction,
  type TimelineRowState,
} from "./statusTimeline.js";

const MIN = 60_000;
const H14 = Date.UTC(2026, 9, 19, 14); // 14:00 UTC
const at = (hour: number, min = 0, sec = 0) => Date.UTC(2026, 9, 19, hour, min, sec);
const full = (hourStartMs: number, toMs: number): TimelineAction => ({ kind: "full", hourStartMs, toMs });
const add = (hourStartMs: number, fromMs: number, toMs: number): TimelineAction => ({
  kind: "add",
  hourStartMs,
  fromMs,
  toMs,
});
const plan = (nowMs: number, rows: Map<number, TimelineRowState>, maxFullCounts?: number) =>
  planTimeline({
    nowMs,
    currentHourMs: nowMs - (nowMs % HOUR_MS),
    rows,
    ...(maxFullCounts === undefined ? {} : { maxFullCounts }),
  });

/** Every closed hour before `currentHourMs` already holds its final count. */
function finalRows(currentHourMs: number): Map<number, TimelineRowState> {
  const m = new Map<number, TimelineRowState>();
  for (let k = 1; k < TIMELINE_WINDOW_HOURS; k++) {
    const h = currentHourMs - k * HOUR_MS;
    m.set(h, { countedToMs: h + HOUR_MS, computedAtMs: h + HOUR_MS + TIMELINE_SETTLE_MS });
  }
  return m;
}

test("empty table: whole counts of the open hour and the newest closed one, capped at 2", () => {
  assert.deepEqual(plan(at(14, 15), new Map()), [
    full(H14, at(14, 15) - TIMELINE_LAG_MS),
    full(at(13), at(14)),
  ]);
});

test("steady state: one add on the open hour, from counted_to to now - lag", () => {
  const rows = finalRows(H14);
  rows.set(H14, { countedToMs: at(14, 18), computedAtMs: at(14, 19) });
  assert.deepEqual(plan(at(14, 20), rows), [add(H14, at(14, 18), at(14, 19))]);
});

test("first lag of an hour: nothing for the open hour; the closed one is topped up to its end", () => {
  const rows = finalRows(H14);
  rows.set(at(13), { countedToMs: at(13, 58, 30), computedAtMs: at(13, 59, 30) });
  // 14:00:30 - lag = 13:59:30, still inside 13:00.
  assert.deepEqual(plan(at(14, 0, 30), rows), [add(at(13), at(13, 58, 30), at(13, 59, 30))]);
  // 14:01:30: 13:00 is counted to its end; 14:00 gets its first (whole) count.
  rows.set(at(13), { countedToMs: at(13, 59, 30), computedAtMs: at(14, 0, 30) });
  assert.deepEqual(plan(at(14, 1, 30), rows), [
    full(H14, at(14, 0, 30)),
    add(at(13), at(13, 59, 30), at(14)),
  ]);
});

test("a closed hour gets exactly one full recount once the settle margin passes", () => {
  const rows = finalRows(H14);
  rows.set(H14, { countedToMs: at(14, 8), computedAtMs: at(14, 9) });
  rows.set(at(13), { countedToMs: at(14), computedAtMs: at(14, 2) });
  // Counted to its end but still settling: nothing to do for 13:00.
  assert.deepEqual(plan(at(14, 9, 59), rows), [add(H14, at(14, 8), at(14, 8, 59))]);
  // Settled: one full recount, which makes it final. (14:00 is already
  // counted to now - lag, so it has nothing to add this run.)
  rows.set(H14, { countedToMs: at(14, 9), computedAtMs: at(14, 10) });
  assert.deepEqual(plan(at(14, 10), rows), [full(at(13), at(14))]);
  rows.set(at(13), { countedToMs: at(14), computedAtMs: at(14, 10, 1) });
  assert.deepEqual(plan(at(14, 11), rows), [add(H14, at(14, 9), at(14, 10))]);
});

test("a partial row left by an outage is recounted whole once settled", () => {
  // The generator died at 09:41; 09:00 was counted to 09:40 and never again.
  const rows = finalRows(H14);
  rows.set(H14, { countedToMs: at(14, 18), computedAtMs: at(14, 19) });
  rows.set(at(9), { countedToMs: at(9, 40), computedAtMs: at(9, 41) });
  assert.deepEqual(plan(at(14, 20), rows), [add(H14, at(14, 18), at(14, 19)), full(at(9), at(10))]);
});

test("adds are never capped; full counts are, newest first", () => {
  const rows = new Map<number, TimelineRowState>([[H14, { countedToMs: at(14, 3), computedAtMs: at(14, 4) }]]);
  assert.deepEqual(plan(at(14, 5), rows), [
    add(H14, at(14, 3), at(14, 4)),
    full(at(13), at(14)), // still settling, so not final yet
    full(at(12), at(13)),
  ]);
});

test("hours outside the 24h window are never planned", () => {
  const actions = plan(at(14, 15), new Map(), 100);
  assert.equal(actions.length, TIMELINE_WINDOW_HOURS);
  assert.equal(actions.at(-1)!.hourStartMs, H14 - (TIMELINE_WINDOW_HOURS - 1) * HOUR_MS);
});

test("simulated ticks: adds tile each hour, settled hours match ground truth despite late writers", () => {
  // One event every 7s from 27h before 14:00 to 16:00. Most become visible 5s
  // after their timestamp; every 50th is a late writer, visible after 90s
  // (longer than the lag, so the incremental adds miss it).
  const events: Array<{ ts: number; visibleAt: number }> = [];
  for (let ts = H14 - 27 * HOUR_MS, i = 0; ts < at(16); ts += 7_000, i++) {
    events.push({ ts, visibleAt: ts + (i % 50 === 0 ? 90_000 : 5_000) });
  }
  const count = (from: number, to: number, nowMs: number) =>
    events.filter((e) => e.ts >= from && e.ts < to && e.visibleAt <= nowMs).length;
  const truth = (h: number) => events.filter((e) => e.ts >= h && e.ts < h + HOUR_MS).length;

  const store = new Map<number, TimelineRowState & { n: number }>();
  for (let nowMs = at(14, 15); nowMs <= at(15, 30); nowMs += MIN) {
    const actions = plan(nowMs, store);
    for (const a of actions) {
      if (a.kind === "full") {
        store.set(a.hourStartMs, { n: count(a.hourStartMs, a.toMs, nowMs), countedToMs: a.toMs, computedAtMs: nowMs });
        continue;
      }
      const row = store.get(a.hourStartMs)!;
      assert.equal(row.countedToMs, a.fromMs, "an add starts exactly where the last count stopped");
      assert.ok(a.toMs > a.fromMs && a.toMs <= a.hourStartMs + HOUR_MS);
      row.n += count(a.fromMs, a.toMs, nowMs);
      row.countedToMs = a.toMs;
      row.computedAtMs = nowMs;
    }
  }

  const now = at(15, 30);
  const current = at(15);
  assert.equal(store.size, TIMELINE_WINDOW_HOURS + 1, "window filled, plus 15:00 yesterday (the planner never deletes)");
  for (let k = 1; k < TIMELINE_WINDOW_HOURS; k++) {
    const h = current - k * HOUR_MS;
    assert.equal(store.get(h)!.n, truth(h), `settled hour ${new Date(h).toISOString()}`);
  }
  // The open hour is counted up to now - lag; it can only miss late writers.
  const open = store.get(current)!;
  assert.equal(open.countedToMs, now - TIMELINE_LAG_MS);
  const visibleTruth = count(current, open.countedToMs, now);
  assert.ok(open.n <= visibleTruth && open.n >= visibleTruth - Math.ceil(visibleTruth / 50));
});
