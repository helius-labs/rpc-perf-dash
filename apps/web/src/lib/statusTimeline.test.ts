/**
 * No-data and stale handling for the /status timeline (lib/statusTimeline.ts).
 * Run: `node --import tsx --test src/lib/statusTimeline.test.ts` from apps/web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIMELINE_STALE_MS, timelineView, type TimelineRow } from "./statusTimeline";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 19, 14, 20);

const row = (label: string, over: Partial<TimelineRow> = {}): TimelineRow => ({
  label,
  dispatched: 10,
  claimed: 20,
  sampled: 40,
  computedMs: NOW - 30_000,
  complete: true,
  ...over,
});

test("healthy: every counted hour has data, including a counted zero", () => {
  const { points, staleForMs } = timelineView(
    [row("12:00", { dispatched: 0, claimed: 0, sampled: 0 }), row("13:00"), row("14:00", { complete: false })],
    NOW,
  );
  assert.deepEqual(points.map((p) => p.hasData), [true, true, true]);
  assert.equal(points[0]!.dispatched, 0);
  assert.equal(staleForMs, null);
});

test("an hour with no row is no-data, not an empty hour", () => {
  const { points } = timelineView(
    [row("12:00", { dispatched: 0, claimed: 0, sampled: 0, computedMs: null, complete: false }), row("13:00")],
    NOW,
  );
  assert.deepEqual(points.map((p) => p.hasData), [false, true]);
});

test("stalled job: the frozen partial hour turns no-data and the note shows its age", () => {
  const stalledAt = NOW - 7 * MIN;
  const { points, staleForMs } = timelineView(
    [
      row("12:00", { computedMs: stalledAt - 20 * MIN }), // complete: still fine
      row("13:00", { computedMs: stalledAt - 10 * MIN }),
      row("14:00", { computedMs: stalledAt, complete: false }), // partial, frozen
    ],
    NOW,
  );
  assert.deepEqual(points.map((p) => p.hasData), [true, true, false]);
  assert.equal(staleForMs, 7 * MIN);
});

test("the staleness threshold is exclusive", () => {
  const at = timelineView([row("14:00", { computedMs: NOW - TIMELINE_STALE_MS, complete: false })], NOW);
  assert.equal(at.points[0]!.hasData, true);
  assert.equal(at.staleForMs, null);
  const past = timelineView([row("14:00", { computedMs: NOW - TIMELINE_STALE_MS - 1, complete: false })], NOW);
  assert.equal(past.points[0]!.hasData, false);
  assert.equal(past.staleForMs, TIMELINE_STALE_MS + 1);
});
