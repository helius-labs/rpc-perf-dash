/**
 * Which /status timeline hours have trustworthy counts. Pure, so it runs at
 * render time against the clock (the rows themselves are cached 60s) and can
 * be unit-tested without a DB.
 */

/** One hour of `status_timeline_hourly`, as fetchTimeline reads it. */
export interface TimelineRow {
  label: string;
  dispatched: number;
  claimed: number;
  sampled: number;
  /** computed_at in epoch ms; null when the hour has no row. */
  computedMs: number | null;
  /** counted_to has reached the end of the hour. */
  complete: boolean;
}

export interface TimelinePoint {
  label: string;
  dispatched: number;
  claimed: number;
  sampled: number;
  /** False when the hour has no trustworthy counts (never counted, or a
   *  partial count the job stopped updating). Drawn as no-data, not as an
   *  empty hour. */
  hasData: boolean;
}

/** The generator updates the open hour every 60s and fetchTimeline caches 60s,
 *  so a healthy newest computed_at is up to ~2 min old at render. */
export const TIMELINE_STALE_MS = 3 * 60_000;

/**
 * An hour has data if it has a row that is either counted to the end of the
 * hour or was updated within staleMs. A partial count that stopped updating
 * (the job stalled mid-hour) would otherwise freeze as a short bar and read as
 * a throughput drop.
 *
 * `staleForMs` is the age of the newest computed_at when that exceeds staleMs
 * (the job has stalled), else null.
 */
export function timelineView(
  rows: TimelineRow[],
  nowMs: number,
  staleMs: number = TIMELINE_STALE_MS,
): { points: TimelinePoint[]; staleForMs: number | null } {
  let newestMs: number | null = null;
  const points = rows.map((r) => {
    if (r.computedMs !== null && (newestMs === null || r.computedMs > newestMs)) newestMs = r.computedMs;
    const hasData = r.computedMs !== null && (r.complete || nowMs - r.computedMs <= staleMs);
    return { label: r.label, dispatched: r.dispatched, claimed: r.claimed, sampled: r.sampled, hasData };
  });
  const ageMs = newestMs === null ? null : nowMs - newestMs;
  return { points, staleForMs: ageMs !== null && ageMs > staleMs ? ageMs : null };
}
