/**
 * Canonical time-window options for the dashboard and the read API. Single
 * source of truth so the home page, the /challenges page, the /api endpoints,
 * and the /api-reference docs all agree on which window values are valid.
 *
 * `value` is the trailing window in hours; `label` is the UI/short form.
 */
export const WINDOWS = [
  { value: 1, label: "1h" },
  { value: 6, label: "6h" },
  { value: 24, label: "24h" },
  { value: 168, label: "7d" },
  { value: 720, label: "30d" },
] as const;

export type WindowOption = (typeof WINDOWS)[number];

/** Set of valid window-hour values, for O(1) param validation. */
export const WINDOW_VALUES: ReadonlySet<number> = new Set(
  WINDOWS.map((w) => w.value),
);
