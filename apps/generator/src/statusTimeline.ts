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
 * Each run recounts the whole bucket rather than adding deltas, so a crashed or
 * skipped run just gets repaired by the next one. Only buckets that can still
 * change are recounted: the current hour, plus a closed hour until a count
 * taken TIMELINE_SETTLE_MS after it closed has landed (late writers: claims
 * within the 30s challenge TTL, samples inserted after the request finishes).
 * Missing buckets inside the 24h window are backfilled, newest first, at most
 * TIMELINE_MAX_HOURS_PER_RUN per run. In steady state that is one or two
 * single-hour index range scans per run.
 *
 * Runs on its own interval in the generator (never on the rollup tail; see
 * CLAUDE.md). All times come from the DB clock: the current hour from
 * date_trunc('hour', now()), computed_at from now() in the counting transaction.
 */
import { sql } from "drizzle-orm";
import { executeRows, type DbClient } from "@rpcbench/db";

export const STATUS_TIMELINE_INTERVAL_MS = 60_000;

/** Buckets the web shows: the current hour and the 23 before it. */
export const TIMELINE_WINDOW_HOURS = 24;

/** A closed hour is recounted until a count taken this long after it ended
 *  lands. Late writers finish <~2 min after a bucket closes (see
 *  docs/operations.md § Rollup build-job memory safety). */
export const TIMELINE_SETTLE_MS = 10 * 60_000;

/** Cap per run, so the first run after deploy backfills the 24h window over a
 *  few ticks instead of in one burst of 24 counts. */
export const TIMELINE_MAX_HOURS_PER_RUN = 6;

const TIMELINE_RETENTION = "8 days";

/** One hour's counts get this long. A single-hour range count is far below
 *  it; it only stops a count from hanging the job on a struggling DB. */
const TIMELINE_STATEMENT_TIMEOUT = "60s";

export const HOUR_MS = 3_600_000;

/**
 * Hour buckets (epoch ms of hour_start) to (re)count this run, newest first.
 *
 * A bucket is included when it has no row yet, or when its row was computed
 * before hour_end + settleMs. The current hour always qualifies (its row can't
 * have been computed after it ended). Buckets older than the window are left
 * alone.
 */
export function planTimelineHours(opts: {
  /** date_trunc('hour', now()) from the DB, epoch ms. */
  currentHourMs: number;
  /** hour_start → computed_at (epoch ms) for rows already in the table. */
  computedAtMs: ReadonlyMap<number, number>;
  windowHours?: number;
  settleMs?: number;
  maxHours?: number;
}): number[] {
  const windowHours = opts.windowHours ?? TIMELINE_WINDOW_HOURS;
  const settleMs = opts.settleMs ?? TIMELINE_SETTLE_MS;
  const maxHours = opts.maxHours ?? TIMELINE_MAX_HOURS_PER_RUN;
  const out: number[] = [];
  for (let k = 0; k < windowHours && out.length < maxHours; k++) {
    const hourStart = opts.currentHourMs - k * HOUR_MS;
    const computedAt = opts.computedAtMs.get(hourStart);
    if (computedAt === undefined || computedAt < hourStart + HOUR_MS + settleMs) {
      out.push(hourStart);
    }
  }
  return out;
}

/** Recount one hour bucket and upsert its row. */
async function countHour(db: DbClient, hourStartMs: number): Promise<void> {
  const from = new Date(hourStartMs).toISOString();
  const to = new Date(hourStartMs + HOUR_MS).toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${TIMELINE_STATEMENT_TIMEOUT}'`));
    // Literal bounds (not a correlated reference) so `samples` gets plan-time
    // partition pruning and each count is a plain index range scan.
    await tx.execute(sql`
      INSERT INTO status_timeline_hourly (hour_start, dispatched, claimed, sampled, computed_at)
      SELECT ${from}::timestamptz,
        (SELECT count(*) FROM challenges
          WHERE generated_at >= ${from}::timestamptz AND generated_at < ${to}::timestamptz)::int,
        (SELECT count(*) FROM challenge_assignments
          WHERE claimed_at >= ${from}::timestamptz AND claimed_at < ${to}::timestamptz)::int,
        (SELECT count(*) FROM samples
          WHERE started_at >= ${from}::timestamptz AND started_at < ${to}::timestamptz)::int,
        now()
      ON CONFLICT (hour_start) DO UPDATE SET
        dispatched  = EXCLUDED.dispatched,
        claimed     = EXCLUDED.claimed,
        sampled     = EXCLUDED.sampled,
        computed_at = EXCLUDED.computed_at
    `);
  });
}

/**
 * One run: recount the buckets planTimelineHours picks, then prune rows past
 * TIMELINE_RETENTION. Stops at the first failed count (the next run retries)
 * rather than pressing on against a struggling DB. Returns hours recounted.
 */
export async function runStatusTimeline(db: DbClient): Promise<number> {
  const [head] = await executeRows<{ current_hour_ms: number }>(db, sql`
    SELECT (extract(epoch from date_trunc('hour', now())) * 1000)::float8 AS current_hour_ms
  `);
  const currentHourMs = Number(head!.current_hour_ms);
  const rows = await executeRows<{ hour_ms: number; computed_ms: number }>(db, sql`
    SELECT (extract(epoch from hour_start) * 1000)::float8 AS hour_ms,
           (extract(epoch from computed_at) * 1000)::float8 AS computed_ms
    FROM status_timeline_hourly
    WHERE hour_start > to_timestamp(${currentHourMs / 1000}::float8)
                       - ${sql.raw(`interval '${TIMELINE_WINDOW_HOURS} hours'`)}
  `);
  const computedAtMs = new Map(rows.map((r) => [Number(r.hour_ms), Number(r.computed_ms)]));

  const hours = planTimelineHours({ currentHourMs, computedAtMs });
  for (const h of hours) await countHour(db, h);

  await db.execute(sql`
    DELETE FROM status_timeline_hourly
    WHERE hour_start < now() - ${sql.raw(`interval '${TIMELINE_RETENTION}'`)}
  `);
  return hours.length;
}
