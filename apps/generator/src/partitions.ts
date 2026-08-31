/**
 * Daily partition cron for `samples` and `landing_tx_results`.
 *
 * `samples` retention: 7 days (raw rows; the 30-day dashboard view is served by
 * rollups grain='1d', not raw samples).
 *
 * There is NO archive table. `samples_archived` existed to hold a 30-day tail of
 * rows that still had a `raw_response`, and it was removed on 2026-08-31 (see
 * migration 0003) because it was 84% of a 2.18 TB database while having zero
 * readers — nothing in apps/ or packages/ ever SELECTed it. Two things made it
 * that expensive:
 *
 *   1. It inherited the `raw_response` sizing problem: ~19k honeypot getBlock
 *      rows/day at ~1.8 MB stored each, ~99.75% of which had passed. record.ts
 *      now keeps raw only for correctness failures + honeypot MISSES, so the
 *      forensic tail is ~115 MB/day instead of ~34 GB/day.
 *
 *   2. Its `INSERT ... SELECT ... ON CONFLICT DO NOTHING` copy was idempotent in
 *      ROWS but not in BYTES. A re-run re-TOASTed every 1.8 MB body before
 *      discovering the row already existed, and those chunks died on arrival.
 *      Measured on 2026-08-31: the archive's TOAST relations showed exactly 2.00
 *      inserts per live chunk and ~51% page utilization, against 1.02 and ~98%
 *      for the same rows in `samples`. Autovacuum reclaimed the dead chunks into
 *      free space the relation never gave back, so the archive cost exactly 2x
 *      what its own data was worth. The copy re-ran because the `DROP TABLE` at
 *      the tail of the same DO block could fail into the EXCEPTION handler,
 *      leaving the partition in place for the next tick to redo.
 *
 * If a forensic tail longer than 7 days is ever wanted again, do NOT reintroduce
 * a full-row copy: keep a narrow projection (challenge_id, provider_id, method,
 * response_hash, error_code) and leave the bodies in the 7-day window, or the
 * byte problem comes straight back.
 *
 * Dropping a daily partition reclaims its space physically and immediately (no
 * VACUUM needed) — this is the primary storage bound.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@rpcbench/db";

// Raw per-sample rows are the bulk of DB size. The 30-day dashboard view is
// served entirely by rollups grain='1d' (1-day granularity at the 30-day edge), NOT by
// raw samples, so we keep only a short raw window for /raw + recent detail and
// drop the rest early.
const SAMPLES_RETENTION_DAYS = 7;
// Send-archetype raw table (migration 0002). landing_tx_results mirrors samples
// (the /sends board reads from send_rollups, not raw rows).
const LANDING_RETENTION_DAYS = 7;
// Create partitions this many days ahead so one never has to be created
// just-in-time at the midnight-UTC boundary (a JIT create racing live inserts
// there is what triggered the outage).
const PARTITION_LEAD_DAYS = 4;
// Partition DDL takes ACCESS EXCLUSIVE on the parent. A short lock_timeout means
// that if a slow insert is holding the table, the CREATE/DROP gives up and retries
// next tick instead of QUEUEING the ACCESS EXCLUSIVE request — which would block
// every subsequent insert behind it (the lock convoy that froze the fleet).
const PARTITION_LOCK_TIMEOUT = "3s";

export async function ensurePartitions(db: DbClient): Promise<void> {
  // Extend partitions forward for both tables (today through the lead window).
  // DO blocks use raw SQL — postgres-js can't infer types for integer params
  // bound inside plpgsql contexts.
  for (const table of ["samples", "landing_tx_results"] as const) {
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

  // Drop partitions past retention. Append-only tables partitioned daily with
  // `<table>_YYYYMMDD` naming, so a plain drop reclaims space immediately.
  for (const [table, retentionDays] of [
    ["samples", SAMPLES_RETENTION_DAYS],
    ["landing_tx_results", LANDING_RETENTION_DAYS],
  ] as const) {
    const prefixLen = `${table}_`.length + 1; // 1-indexed substring start of YYYYMMDD
    await db.execute(
      sql.raw(`
        DO $do$
        DECLARE
          r record;
          cutoff date := current_date - ${retentionDays};
        BEGIN
          FOR r IN
            SELECT child.relname AS pname
            FROM pg_inherits
            JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
            JOIN pg_class child  ON child.oid  = pg_inherits.inhrelid
            WHERE parent.relname = '${table}'
              AND child.relname ~ '^${table}_[0-9]{8}$'
              AND to_date(substring(child.relname FROM ${prefixLen} FOR 8), 'YYYYMMDD') < cutoff
          LOOP
            -- Per-partition savepoint + short lock_timeout. A DROP of a partition
            -- needs ACCESS EXCLUSIVE on the PARENT, so without the timeout a busy
            -- parent would queue that request and stall every subsequent insert
            -- behind it. Retention housekeeping must also never be able to crash
            -- the generator: ensurePartitions is awaited at startup in index.ts,
            -- before the dispatch/heartbeat loops, so a throw here takes the whole
            -- fleet down. A partition that can't be dropped is logged, LEFT IN
            -- PLACE, and retried on the next tick.
            BEGIN
              PERFORM set_config('lock_timeout', '${PARTITION_LOCK_TIMEOUT}', true);
              EXECUTE format('DROP TABLE IF EXISTS %I', r.pname);
            EXCEPTION WHEN OTHERS THEN
              RAISE WARNING '[partitions] drop of % failed, leaving partition in place: %', r.pname, SQLERRM;
            END;
          END LOOP;
        END $do$;
      `),
    );
  }
}
