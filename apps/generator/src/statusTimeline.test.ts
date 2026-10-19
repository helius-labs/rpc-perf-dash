/**
 * Which hour buckets the /status timeline job recounts (planTimelineHours).
 * Run: `node --import tsx --test src/statusTimeline.test.ts` from apps/generator.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOUR_MS,
  TIMELINE_MAX_HOURS_PER_RUN,
  TIMELINE_SETTLE_MS,
  TIMELINE_WINDOW_HOURS,
  planTimelineHours,
} from "./statusTimeline.js";

const CUR = Date.UTC(2026, 9, 19, 14); // 14:00 UTC, the current hour
const MIN = 60_000;
const hoursBack = (k: number) => CUR - k * HOUR_MS;

/** Every closed hour in the window already has a final row (computed after settle). */
function settledWindow(): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = 1; k < TIMELINE_WINDOW_HOURS; k++) {
    m.set(hoursBack(k), hoursBack(k) + HOUR_MS + TIMELINE_SETTLE_MS + MIN);
  }
  return m;
}

test("empty table: backfills newest first, capped per run", () => {
  const plan = planTimelineHours({ currentHourMs: CUR, computedAtMs: new Map() });
  assert.deepEqual(
    plan,
    Array.from({ length: TIMELINE_MAX_HOURS_PER_RUN }, (_, k) => hoursBack(k)),
  );
});

test("steady state: only the current hour is recounted", () => {
  const m = settledWindow();
  m.set(CUR, CUR + 20 * MIN); // the current hour's row from the last run
  assert.deepEqual(planTimelineHours({ currentHourMs: CUR, computedAtMs: m }), [CUR]);
});

test("a just-closed hour is recounted until a count lands after the settle margin", () => {
  const prev = hoursBack(1);
  const m = settledWindow();

  m.set(prev, CUR + 3 * MIN); // counted 3 min after it closed: late writers may still land
  assert.deepEqual(planTimelineHours({ currentHourMs: CUR, computedAtMs: m }), [CUR, prev]);

  m.set(prev, CUR + TIMELINE_SETTLE_MS); // counted exactly at the margin: final
  assert.deepEqual(planTimelineHours({ currentHourMs: CUR, computedAtMs: m }), [CUR]);
});

test("an hour last counted while still open is recounted however old it is", () => {
  // e.g. the generator was down from 09:59 until now: 09:00's row is partial.
  const h = hoursBack(5);
  const m = settledWindow();
  m.set(h, h + HOUR_MS - 30_000);
  assert.deepEqual(planTimelineHours({ currentHourMs: CUR, computedAtMs: m }), [CUR, h]);
});

test("hours outside the 24h window are never planned", () => {
  const plan = planTimelineHours({ currentHourMs: CUR, computedAtMs: new Map(), maxHours: 100 });
  assert.equal(plan.length, TIMELINE_WINDOW_HOURS);
  assert.equal(plan.at(-1), hoursBack(TIMELINE_WINDOW_HOURS - 1)); // 15:00 yesterday
  assert.ok(!plan.includes(hoursBack(TIMELINE_WINDOW_HOURS)));
});

test("first runs after deploy fill the whole window, then settle to the current hour", () => {
  // Every run happens at 14:15 and stamps the hours it counts with that time.
  const now = CUR + 15 * MIN;
  const m = new Map<number, number>();
  const runs: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const plan = planTimelineHours({ currentHourMs: CUR, computedAtMs: m });
    runs.push(plan);
    for (const h of plan) m.set(h, now);
  }
  // 23 closed hours at 5 per run (the current hour takes one slot each run).
  assert.deepEqual(runs.map((r) => r.length), [6, 6, 6, 6, 4, 1]);
  assert.deepEqual(runs[5], [CUR]);
  assert.equal(m.size, TIMELINE_WINDOW_HOURS);
  // Each closed hour was counted once, at 14:15, which is past 13:00's settle margin.
  const closed = runs.flat().filter((h) => h !== CUR);
  assert.equal(new Set(closed).size, closed.length);
});
