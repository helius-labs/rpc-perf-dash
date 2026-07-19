import { sql } from "drizzle-orm";
import { type DbClient, firstRow } from "@rpcbench/db";
import { hostname } from "node:os";

const ADVISORY_LOCK_KEY = 0x52504342_47454e31n; // 'RPCBGEN1'
// pg_locks splits a single bigint advisory key into classid (high 32) + objid (low 32).
const ADVISORY_LOCK_CLASSID = Number(ADVISORY_LOCK_KEY >> 32n);
const ADVISORY_LOCK_OBJID = Number(ADVISORY_LOCK_KEY & 0xffffffffn);

/** Acquire the generator leader lock. Returns true if this process is now the leader. */
export async function acquireLeader(db: DbClient): Promise<boolean> {
  // BigInt params trip postgres-js's type inference; inline as raw bigint literal.
  const r = await firstRow<{ got: boolean }>(
    db,
    sql.raw(`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY.toString()}::bigint) AS got`),
  );
  return r?.got === true;
}

/** Force-evict any other generator process whose heartbeat is stale OR
 * whose advisory-lock-holder DB session is now idle/orphan, then retry. */
export async function evictAndAcquireLeader(db: DbClient, staleSeconds = 30): Promise<boolean> {
  // Path 1: heartbeat-based eviction (intended use).
  const r = await firstRow<{ pid: number }>(
    db,
    sql.raw(`
      SELECT pid FROM generator_heartbeat
      WHERE beat_at < now() - make_interval(secs => ${staleSeconds})
    `),
  );
  if (r?.pid) {
    await db.execute(sql.raw(`SELECT pg_terminate_backend(${r.pid})`)).catch(() => {});
  }

  // Path 2: orphan-session eviction. If our advisory lock is held by a DB
  // session that has been idle for >staleSeconds, the holding generator is
  // dead but its connection is still hanging around in Neon's pool. Forcibly
  // terminate it so the lock releases.
  await db
    .execute(
      sql.raw(`
        SELECT pg_terminate_backend(l.pid)
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.classid = ${ADVISORY_LOCK_CLASSID}
          AND l.objid   = ${ADVISORY_LOCK_OBJID}
          AND a.state   = 'idle'
          AND a.state_change < now() - make_interval(secs => ${staleSeconds})
      `),
    )
    .catch(() => {});

  return acquireLeader(db);
}

export async function writeHeartbeat(db: DbClient): Promise<void> {
  await db.execute(sql`
    INSERT INTO generator_heartbeat (id, pid, hostname, beat_at)
    VALUES (1, ${process.pid}, ${hostname()}, now())
    ON CONFLICT (id) DO UPDATE
      SET pid = EXCLUDED.pid, hostname = EXCLUDED.hostname, beat_at = now()
  `);
}
