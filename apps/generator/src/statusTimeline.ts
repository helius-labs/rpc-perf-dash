/**
 * Hourly pipeline counts for the /status "Throughput · 24h" timeline.
 *
 * The web used to count `challenges` and `challenge_assignments` by time range
 * over 24h on every cache miss (~210k + ~640k rows). Both tables are
 * update-heavy, so the index scans hit the heap, and cold they ran past the web
 * read lanes. This job keeps `status_timeline_hourly` (migration 0003) current
 * instead, and the web reads ~24 rows by primary key.
 *
 * Per hour bucket [hour_start, hour_start + 1h):
 *   dispatched = challenges by generated_at
 *   claimed    = challenge_assignments by claimed_at
 *   sampled    = samples by started_at (counted here, not read from
 *                leaderboard_agg, so the series doesn't depend on the rollup
 *                job's health)
 *
 * Counting is incremental, because the DB is I/O-bound and recounting a whole
 * hour of `samples` every tick (~200k heap-fetching rows) competes with web
 * reads. A row's counts cover [hour_start, counted_to). Each tick adds the rows
 * in [counted_to, now() - TIMELINE_LAG_MS) and advances counted_to, so a tick
 * reads about one minute of rows. The lag lets most in-flight writes commit
 * before their range is counted.
 *
 * Incremental counts miss rows that commit after their range was counted (a
 * sample inserted >lag after its started_at, a claim in a long transaction).
 * So once an hour has been closed for TIMELINE_SETTLE_MS, it gets ONE full
 * recount, which replaces its counts and makes the row final. An hour with no
 * row yet (first deploy, or a generator outage) is counted whole once. Full
 * counts are capped at TIMELINE_MAX_FULL_COUNTS_PER_RUN per run, newest first,
 * so a backfill spreads over several ticks.
 *
 * Runs on its own interval in the generator (never on the rollup tail; see
 * CLAUDE.md), first firing STATUS_TIMELINE_STARTUP_DELAY_MS after startup so it
 * stays clear of the startup rollups and leaderboard build. All times come from
 * the DB clock.
 */
import { sql } from "drizzle-orm";
import { executeRows, type DbClient } from "@rpcbench/db";

export const STATUS_TIMELINE_INTERVAL_MS = 60_000;

/** First run waits this long after startup, behind the startup rollups and
 *  the leaderboard build (~40s warm). */
export const STATUS_TIMELINE_STARTUP_DELAY_MS = 2 * 60_000;

/** Buckets the web shows: the current hour and the 23 before it. */
export const TIMELINE_WINDOW_HOURS = 24;

/** Incremental counts stop this far behind now(), so most rows stamped inside a
 *  range have committed before the range is counted. */
export const TIMELINE_LAG_MS = 60_000;

/** A closed hour gets its final full recount this long after it ends. Late
 *  writers finish <~2 min after a bucket closes (see docs/operations.md
 *  § Rollup build-job memory safety). */
export const TIMELINE_SETTLE_MS = 10 * 60_000;

/** Whole-range counts (backfills and final recounts) per run. Incremental adds
 *  are not capped: there are at most two (the open hour and the settling one). */
export const TIMELINE_MAX_FULL_COUNTS_PER_RUN = 2;

const TIMELINE_RETENTION = "8 days";

/** Each statement gets this long. It only stops a count from hanging the job
 *  on a struggling DB; a single-hour range count is far below it. */
const TIMELINE_STATEMENT_TIMEOUT = "60s";

export const HOUR_MS = 3_600_000;

/** What the table holds for one hour, as epoch ms. */
export interface TimelineRowState {
  countedToMs: number;
  computedAtMs: number;
}

export type TimelineAction =
  /** Count [hourStartMs, toMs) from scratch and replace the row. */
  | { kind: "full"; hourStartMs: number; toMs: number }
  /** Add [fromMs, toMs) to the row, whose counted_to must still be fromMs. */
  | { kind: "add"; hourStartMs: number; fromMs: number; toMs: number };

/**
 * The counting work for one run, newest hour first.
 *
 * Per hour in the window:
 *   - closed for settleMs: one full recount unless the row is already final
 *     (computed at or after hour_end + settleMs);
 *   - otherwise, with no row: a full count up to now - lag (nothing in the
 *     first lagMs of an hour);
 *   - otherwise: an add from counted_to up to min(hour_end, now - lag).
 * Full counts beyond maxFullCounts wait for a later run.
 */
export function planTimeline(opts: {
  /** now() from the DB, epoch ms. */
  nowMs: number;
  /** date_trunc('hour', now()) from the DB, epoch ms. */
  currentHourMs: number;
  /** hour_start → row state, for rows already in the table. */
  rows: ReadonlyMap<number, TimelineRowState>;
  windowHours?: number;
  lagMs?: number;
  settleMs?: number;
  maxFullCounts?: number;
}): TimelineAction[] {
  const windowHours = opts.windowHours ?? TIMELINE_WINDOW_HOURS;
  const lagMs = opts.lagMs ?? TIMELINE_LAG_MS;
  const settleMs = opts.settleMs ?? TIMELINE_SETTLE_MS;
  let fullBudget = opts.maxFullCounts ?? TIMELINE_MAX_FULL_COUNTS_PER_RUN;

  const actions: TimelineAction[] = [];
  for (let k = 0; k < windowHours; k++) {
    const hourStartMs = opts.currentHourMs - k * HOUR_MS;
    const endMs = hourStartMs + HOUR_MS;
    const row = opts.rows.get(hourStartMs);

    if (opts.nowMs >= endMs + settleMs) {
      if (row && row.computedAtMs >= endMs + settleMs) continue; // final
      if (fullBudget > 0) {
        actions.push({ kind: "full", hourStartMs, toMs: endMs });
        fullBudget--;
      }
      continue;
    }

    const upToMs = Math.min(endMs, opts.nowMs - lagMs);
    if (!row) {
      if (upToMs > hourStartMs && fullBudget > 0) {
        actions.push({ kind: "full", hourStartMs, toMs: upToMs });
        fullBudget--;
      }
      continue;
    }
    if (row.countedToMs < upToMs) {
      actions.push({ kind: "add", hourStartMs, fromMs: row.countedToMs, toMs: upToMs });
    }
  }
  return actions;
}

/** The three series: table and the timestamp column bucketed by hour. */
const SOURCES = [
  ["dispatched", "challenges", "generated_at"],
  ["claimed", "challenge_assignments", "claimed_at"],
  ["sampled", "samples", "started_at"],
] as const;

/** count(*) of one source over [from, to). Literal bounds (not a correlated
 *  reference) so `samples` gets plan-time partition pruning and each count is
 *  a plain index range scan. */
function rangeCount(table: string, column: string, from: string, to: string) {
  return sql`(SELECT count(*) FROM ${sql.raw(table)}
    WHERE ${sql.raw(column)} >= ${from}::timestamptz AND ${sql.raw(column)} < ${to}::timestamptz)::int`;
}

const iso = (ms: number) => new Date(ms).toISOString();

async function applyAction(db: DbClient, a: TimelineAction): Promise<void> {
  const hour = iso(a.hourStartMs);
  const to = iso(a.toMs);
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${TIMELINE_STATEMENT_TIMEOUT}'`));
    if (a.kind === "full") {
      const counts = sql.join(SOURCES.map(([, t, c]) => rangeCount(t, c, hour, to)), sql`, `);
      await tx.execute(sql`
        INSERT INTO status_timeline_hourly
          (hour_start, dispatched, claimed, sampled, counted_to, computed_at)
        SELECT ${hour}::timestamptz, ${counts}, ${to}::timestamptz, now()
        ON CONFLICT (hour_start) DO UPDATE SET
          dispatched  = EXCLUDED.dispatched,
          claimed     = EXCLUDED.claimed,
          sampled     = EXCLUDED.sampled,
          counted_to  = EXCLUDED.counted_to,
          computed_at = EXCLUDED.computed_at
      `);
      return;
    }
    const from = iso(a.fromMs);
    const adds = sql.join(
      SOURCES.map(([col, t, c]) => sql`${sql.raw(col)} = ${sql.raw(col)} + ${rangeCount(t, c, from, to)}`),
      sql`, `,
    );
    // The counted_to guard makes the add compare-and-set: if another run (a
    // brief second leader during failover) already moved the watermark, this
    // updates nothing and the next run re-plans from the new counted_to.
    await tx.execute(sql`
      UPDATE status_timeline_hourly
      SET ${adds}, counted_to = ${to}::timestamptz, computed_at = now()
      WHERE hour_start = ${hour}::timestamptz AND counted_to = ${from}::timestamptz
    `);
  });
}

/**
 * One run: plan from the table's current state, apply the actions in order,
 * then prune rows past TIMELINE_RETENTION. Stops at the first failed statement
 * (the next run re-plans and retries) rather than pressing on against a
 * struggling DB. Returns the number of actions applied.
 */
export async function runStatusTimeline(db: DbClient): Promise<number> {
  const [clock] = await executeRows<{ now_ms: number; current_hour_ms: number }>(db, sql`
    SELECT floor(extract(epoch from now()) * 1000)::float8                     AS now_ms,
           (extract(epoch from date_trunc('hour', now())) * 1000)::float8      AS current_hour_ms
  `);
  const nowMs = Number(clock!.now_ms);
  const currentHourMs = Number(clock!.current_hour_ms);

  const rows = await executeRows<{ hour_ms: number; counted_to_ms: number; computed_ms: number }>(db, sql`
    SELECT (extract(epoch from hour_start) * 1000)::float8  AS hour_ms,
           (extract(epoch from counted_to) * 1000)::float8  AS counted_to_ms,
           (extract(epoch from computed_at) * 1000)::float8 AS computed_ms
    FROM status_timeline_hourly
    WHERE hour_start > ${iso(currentHourMs)}::timestamptz
                       - ${sql.raw(`interval '${TIMELINE_WINDOW_HOURS} hours'`)}
  `);
  const state = new Map<number, TimelineRowState>(
    rows.map((r) => [
      Number(r.hour_ms),
      { countedToMs: Number(r.counted_to_ms), computedAtMs: Number(r.computed_ms) },
    ]),
  );

  const actions = planTimeline({ nowMs, currentHourMs, rows: state });
  for (const a of actions) await applyAction(db, a);

  await db.execute(sql`
    DELETE FROM status_timeline_hourly
    WHERE hour_start < now() - ${sql.raw(`interval '${TIMELINE_RETENTION}'`)}
  `);
  return actions.length;
}
