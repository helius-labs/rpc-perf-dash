/**
 * Time-bin options for the latency/score chart, shared by the live chart
 * (LatencyChart) and its loading skeleton (ChartSection) so the Bin control
 * looks identical while data streams in. options[0] is the native source grain
 * (selecting it does no averaging).
 */

export type ChartMetric = "latency" | "score";

export function binOptionsForWindow(windowHours: number, metric: ChartMetric): [number, ...number[]] {
  // The score series reads the leaderboard precompute (hourly ≤7d, daily >7d) —
  // no 5-min score grain — so its native bin floor is 1h, not 5m.
  if (metric === "score") {
    return windowHours <= 168 ? [60, 180, 360, 720] : [1440];
  }
  if (windowHours <= 24) return [5, 10, 15, 30, 60]; // 5-min source
  if (windowHours <= 168) return [60, 180, 360, 720]; // hourly source: 1h/3h/6h/12h
  return [1440]; // daily source: only 1d is meaningful → control hidden
}

export function binLabel(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${min / 60}h`;
  return `${min / 1440}d`;
}
