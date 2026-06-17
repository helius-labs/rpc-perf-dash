/**
 * Daily partition cron for `samples` and `samples_archived`.
 *
 * `samples` retention: 30 days.
 * `samples_archived` retention: 90 days.
 *
 * Before a `samples_YYYYMMDD` partition is dropped, this cron copies its
 * "archive-rule" rows (deterministic 1% sample, all flagged, all honeypots)
 * into the matching `samples_archived_YYYYMMDD` partition. That's how the
 * 90-day raw-archive promise in methodology.md actually holds.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";

const SAMPLES_RETENTION_DAYS = 30;
const ARCHIVE_RETENTION_DAYS = 90;

export async function ensurePartitions(db: DbClient): Promise<void> {
  // Extend partitions forward for both tables (today, tomorrow, day-after).
  // DO blocks use raw SQL — postgres-js can't infer types for integer params
  // bound inside plpgsql contexts.
  for (const table of ["samples", "samples_archived"] as const) {
    for (let i = 0; i <= 2; i++) {
      await db.execute(
        sql.raw(`
          DO $do$
          DECLARE
            d date := current_date + ${i};
          BEGIN
            EXECUTE format(
              'CREATE TABLE IF NOT EXISTS ${table}_%s PARTITION OF ${table} FOR VALUES FROM (%L) TO (%L)',
              to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz
            );
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
