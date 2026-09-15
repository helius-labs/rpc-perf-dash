/**
 * Regenerate `apps/web/src/lib/sendsSnapshot.ts` from the live send board.
 *
 *   pnpm snapshot:sends              # prints the file to stdout
 *   pnpm snapshot:sends --write      # overwrites the file in place
 *
 * The embed at /embed/sends-snapshot renders that file and nothing else, so
 * publishing a new snapshot is: run this, review the diff, open a PR.
 *
 * Two rules keep the date honest, and both live in the request below:
 *   - `complete=1` — the board's default newest bucket is the CURRENT day,
 *     still filling. Publishing it would date a partial day as if it were a
 *     whole one.
 *   - `asOf` comes from `window_start`, the day the bucket covers. `window_end`
 *     is the EXCLUSIVE bound (Sep 14's bucket ends Sep 15), so stamping from it
 *     dates every snapshot a day late.
 */

const SITE = process.env.SNAPSHOT_SITE_URL ?? "https://www.helius.dev/benchmarks";
const GRAINS = ["1h", "1d"];
const GRAIN = process.env.SNAPSHOT_GRAIN ?? "1d";
const WRITE = process.argv.includes("--write");

const OUT = new URL("../src/lib/sendsSnapshot.ts", import.meta.url);

/** Round to `n` decimals, preserving null. */
const r = (v, n) => (v == null ? null : Number(v.toFixed(n)));

function fail(msg) {
  console.error(`snapshot-sends: ${msg}`);
  process.exit(1);
}

// The API coerces an unknown grain to 1d, but this script writes the raw value
// into a `grain: "1h" | "1d"` field — so a typo would silently pair 1d numbers
// with a label that doesn't typecheck. Reject it here instead.
if (!GRAINS.includes(GRAIN)) fail(`SNAPSHOT_GRAIN must be one of ${GRAINS.join(" | ")}`);

const url = `${SITE}/api/sends?grain=${encodeURIComponent(GRAIN)}&complete=1`;
const res = await fetch(url).catch((e) => fail(`fetch ${url} — ${e.message}`));
if (!res.ok) fail(`${url} returned ${res.status}`);
const body = await res.json();

if (!Array.isArray(body.rows) || body.rows.length === 0) fail("no rows in response");
// Refuse to stamp a date the API didn't give us. A snapshot with a wrong date
// is worse than no snapshot: the whole point of the static card is that the
// numbers and the date on it describe the same period.
if (!body.window_start) fail("response has no window_start — deploy the API change first");
// Belt and braces on top of complete=1: never publish a bucket that hasn't
// ended, whatever the server thought.
if (new Date(body.window_end).getTime() > Date.now()) {
  fail(`bucket ending ${body.window_end} is still filling — nothing to publish yet`);
}

const asOf = body.window_start.slice(0, 10);
const rows = body.rows.map((x) => ({
  rank: x.rank,
  send_target: x.send_target,
  total: r(x.total, 2),
  landing_rate: r(x.landing_rate, 5),
  slot_latency_p50: r(x.slot_latency_p50, 2),
  slot_latency_p95: r(x.slot_latency_p95, 2),
  cost_lamports: x.cost_lamports,
  sample_count_total: x.sample_count_total,
  outcomes: x.outcomes,
}));

const lit = (v) => JSON.stringify(v);
const rowLines = rows
  .map(
    (x) => `    {
      rank: ${x.rank},
      send_target: ${lit(x.send_target)},
      total: ${x.total},
      landing_rate: ${x.landing_rate},
      slot_latency_p50: ${x.slot_latency_p50},
      slot_latency_p95: ${x.slot_latency_p95},
      cost_lamports: ${x.cost_lamports},
      sample_count_total: ${x.sample_count_total},
      outcomes: { landed: ${x.outcomes.landed}, reverted: ${x.outcomes.reverted}, not_landed: ${x.outcomes.not_landed}, submit_error: ${x.outcomes.submit_error} },
    },`,
  )
  .join("\n");

const file = `/**
 * Frozen copy of the send leaderboard, rendered by /embed/sends-snapshot.
 *
 * GENERATED — do not hand-edit. Run \`pnpm snapshot:sends --write\`, review the
 * diff, and land it as a PR. Hand-editing risks a date that doesn't match the
 * numbers, which is the one failure mode this whole file exists to prevent.
 *
 * The embed prints \`asOf\` next to the rows and links to the live board, so a
 * snapshot that stops being refreshed reads as visibly stale rather than as a
 * current claim.
 */

import type { SendsLeaderboardRow } from "@/components/SendsLeaderboard";

export interface SendsSnapshot {
  /** The day the rows cover (UTC, from the API's window_start) — NOT the
   *  generation date, and NOT window_end, which is the exclusive bound. */
  asOf: string;
  /** Rollup grain the rows were scored over — a COMPLETED bucket. */
  grain: "1h" | "1d";
  rows: SendsLeaderboardRow[];
}

export const SENDS_SNAPSHOT: SendsSnapshot = {
  asOf: ${lit(asOf)},
  grain: ${lit(GRAIN)},
  rows: [
${rowLines}
  ],
};
`;

if (WRITE) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT, file);
  console.error(`snapshot-sends: wrote ${rows.length} rows, asOf ${asOf}`);
} else {
  process.stdout.write(file);
}
