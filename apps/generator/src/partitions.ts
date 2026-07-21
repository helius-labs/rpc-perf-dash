/**
 * Daily partition cron for `samples` and `samples_archived`.
 *
 * `samples` retention: 7 days (raw rows; the 30-day dashboard view is served by
 * rollups grain='1d', not raw samples).
 * `samples_archived` retention: 30 days.
 *
 * Before a `samples_YYYYMMDD` partition is dropped, this cron copies its rows
 * that still have a `raw_response` into the matching `samples_archived_YYYYMMDD`
 * partition (the INSERT below filters `WHERE raw_response IS NOT NULL`). Since
 * `record.ts` keeps `raw_response` only for flagged + honeypot samples, the
 * 90-day archive holds exactly those — NOT the old representative 1% normal
 * sample (that 1% archival was dropped to bound DB growth). The public
 * `/raw?challenge=<id>` view still shows full per-provider detail for the live
 * 30-day window from `samples`.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";

// Raw per-sample rows are the bulk of DB size. The 30-day dashboard view is
// served entirely by rollups grain='1d' (1-day granularity at the 30-day edge), NOT by
// raw samples, so we keep only a short raw window for /raw + recent detail and
// drop the rest early. Dropping a daily partition reclaims its space physically
// and immediately (no VACUUM needed) — this is the primary storage bound.
const SAMPLES_RETENTION_DAYS = 7;
// samples_archived holds only flagged + honeypot rows (tiny), kept for 30d.
const ARCHIVE_RETENTION_DAYS = 30;
// Create partitions this many days ahead so one never has to be created
// just-in-time at the midnight-UTC boundary (a JIT create racing live inserts
// there is what triggered the outage).
const PARTITION_LEAD_DAYS = 4;
// Partition DDL takes ACCESS EXCLUSIVE on the parent. A short lock_timeout means
// that if a slow insert is holding the table, the CREATE gives up and retries
// next tick instead of QUEUEING the ACCESS EXCLUSIVE request — which would block
// every subsequent insert behind it (the lock convoy that froze the fleet).
const PARTITION_LOCK_TIMEOUT = "3s";

export async function ensurePartitions(db: DbClient): Promise<void> {
  // Extend partitions forward for both tables (today, tomorrow, day-after).
  // DO blocks use raw SQL — postgres-js can't infer types for integer params
  // bound inside plpgsql contexts.
  for (const table of ["samples", "samples_archived"] as const) {
    for (let i = 0; i <= PARTITION_LEAD_DAYS; i++) {
      await db.execute(
        sql.raw(`
          DO $do$
          DECLARE
            d date := current_date + ${i};
          BEGIN
            PERFORM set_config('lock_timeout', '${PARTITION_LOCK_TIMEOUT}', true);
            EXECUTE format(
              'CREATE TABLE IF NOT EXISTS ${table}_%s PARTITION OF ${table} FOR VALUES FROM (%L) TO (%L)',
              to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
            );
          EXCEPTION WHEN OTHERS THEN
            -- Never crash the generator on a partition create: a lock_timeout
            -- (table busy) or transient error is logged and retried next tick.
            -- Ample lead days mean a single missed tick is harmless.
            RAISE WARNING '[partitions] create ${table}_% failed, will retry: %', to_char(d, 'YYYYMMDD'), SQLERRM;
          END $do$;
        `),
      );
    }
  }

  // For each `samples_YYYYMMDD` partition that is about to be dropped, copy
  // archive-rule rows into the matching archive partition first.
  await db.execute(
    sql.raw(`
      DO $do$
      DECLARE
        r record;
        cols text;
        cutoff date := current_date - ${SAMPLES_RETENTION_DAYS};
      BEGIN
        -- Explicit column list = the columns samples_archived actually has,
        -- in attnum order. NEVER use 'INSERT ... SELECT *' here: it maps by
        -- position and silently breaks whenever 'samples' gains a column the
        -- archive lacks (e.g. migration 0006 added failure_category/
        -- failure_detail to samples only). Listing samples_archived's columns
        -- is position-safe and drift-proof: samples-only columns are simply
        -- not archived.
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
          INTO cols
        FROM pg_attribute
        WHERE attrelid = 'samples_archived'::regclass
          AND attnum > 0
          AND NOT attisdropped;

        FOR r IN
          SELECT child.relname AS pname,
                 to_date(substring(child.relname FROM 9 FOR 8), 'YYYYMMDD') AS pday
          FROM pg_inherits
          JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
          JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
          WHERE parent.relname = 'samples'
            AND child.relname ~ '^samples_[0-9]{8}$'
            AND to_date(substring(child.relname FROM 9 FOR 8), 'YYYYMMDD') < cutoff
        LOOP
          -- Archival is best-effort housekeeping and MUST NOT be able to crash
          -- the generator: this runs awaited at startup (index.ts) before the
          -- dispatch/heartbeat loops, so any throw here takes the whole fleet
          -- down. A partition that can't be archived (e.g. historical rows that
          -- violate a since-tightened CHECK like samples_egress_chk) is logged
          -- and LEFT IN PLACE — never dropped on a failed copy — and retried on
          -- the next cron tick. A fatal archive error here would otherwise
          -- crashloop the generator.
          BEGIN
            EXECUTE format(
              'CREATE TABLE IF NOT EXISTS samples_archived_%s PARTITION OF samples_archived FOR VALUES FROM (%L) TO (%L)',
              to_char(r.pday, 'YYYYMMDD'),
              r.pday::timestamptz,
              (r.pday + 1)::timestamptz
            );
            EXECUTE format(
              'INSERT INTO samples_archived_%s (%s)
               SELECT %s FROM %I WHERE raw_response IS NOT NULL
               ON CONFLICT DO NOTHING',
              to_char(r.pday, 'YYYYMMDD'),
              cols, cols,
              r.pname
            );
            EXECUTE format('DROP TABLE IF EXISTS %I', r.pname);
          EXCEPTION WHEN OTHERS THEN
            RAISE WARNING '[partitions] archive of % failed, leaving partition in place: %', r.pname, SQLERRM;
          END;
        END LOOP;
      END $do$;
    `),
  );

  // Prune samples_archived partitions older than 90 days.
  await db.execute(
    sql.raw(`
      DO $do$
      DECLARE
        r record;
        cutoff date := current_date - ${ARCHIVE_RETENTION_DAYS};
      BEGIN
        FOR r IN
          SELECT child.relname AS pname
          FROM pg_inherits
          JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
          JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
          WHERE parent.relname = 'samples_archived'
            AND child.relname ~ '^samples_archived_[0-9]{8}$'
            AND to_date(substring(child.relname FROM 18 FOR 8), 'YYYYMMDD') < cutoff
        LOOP
          EXECUTE format('DROP TABLE IF EXISTS %I', r.pname);
        END LOOP;
      END $do$;
    `),
  );

}
