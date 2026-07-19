/**
 * Server-side fetcher for the /challenges browse table + the
 * `/api/challenges` polling route. Same SQL, same shape, single source of
 * truth so SSR + client polling stay in sync — the same split
 * lib/recentChallenges.ts provides for the Performance page's table.
 *
 * Client-safe types / filter parsing live in lib/challengeFilters.ts.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import {
  PAGE_SIZE,
  type ChallengeRow,
  type ChallengesFilters,
  type ChallengesFiltersNoOffset,
} from "@/lib/challengeFilters";

/**
 * Shared WHERE for the row + count queries. Filters compose dynamically;
 * postgres-js binds each parameter.
 *
 * Bucket filter: exact match if the value contains `__` (a full id like
 * `archival__low`), else a family-prefix match covering every variant
 * (`archival` → all archival__*), so the dropdown's "all" row for a family
 * matches the whole group.
 */
export function whereFor(f: ChallengesFiltersNoOffset) {
  const { method, bucket: effectiveBucket, status, window, target } = f;
  const bucketCond = effectiveBucket
    ? effectiveBucket.includes("__")
      ? sql`c.bucket = ${effectiveBucket}`
      : sql`(c.bucket = ${effectiveBucket} OR c.bucket LIKE ${effectiveBucket + "__%"})`
    : null;
  const conds = [
    sql`c.generated_at > now() - make_interval(hours => ${window})`,
    method ? sql`c.method = ${method}` : null,
    bucketCond,
    status ? sql`c.status = ${status}` : null,
    target ? sql`c.params::text ILIKE ${"%" + target + "%"}` : null,
    sql`c.is_honeypot = false`,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  return sql`WHERE ${sql.join(conds, sql` AND `)}`;
}

/**
 * The page slice. This is the only query keyed by `offset`, so paging Prev/Next
 * re-runs only this — the count + bucket queries stay cached.
 *
 * Two structural choices keep this fast:
 *
 *   1. The page of challenges is selected first (WHERE + ORDER BY + LIMIT/OFFSET
 *      on `challenges` alone, no join) in the `page` CTE, then the LATERAL
 *      sample-count join runs only on those ≤50 rows. The old shape had the
 *      LATERAL at top level, so OFFSET made it fire for every *skipped* row too
 *      (~15ms/row → OFFSET 500 ≈ 8s). Now OFFSET cost is just an index scan over
 *      the skipped challenge rows + exactly PAGE_SIZE LATERAL probes.
 *
 *   2. The LATERAL bounds `started_at` to a window around the challenge's
 *      `generated_at`. `samples` is partitioned daily by `started_at`, so this
 *      lets the executor runtime-prune to the 1–2 partitions that can hold the
 *      challenge's samples instead of probing all ~30. A challenge's TTL is 30s,
 *      so every sample lands within seconds of `generated_at`; the bound is wide
 *      (−1h/+6h) so worker↔DB clock skew can't drop a lagging worker's samples
 *      and undercount the consensus columns.
 */
async function fetchChallengeRowsImpl(f: ChallengesFilters): Promise<ChallengeRow[]> {
  const where = whereFor(f);
  const rows = await db().execute(sql`
    WITH page AS (
      SELECT c.id, c.method, c.bucket, c.status, c.generated_at, c.params, c.is_honeypot
      FROM challenges c
      ${where}
      ORDER BY c.generated_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${f.offset}
    )
    SELECT
      page.id::text AS id,
      page.method,
      page.bucket,
      page.status,
      page.generated_at,
      page.params,
      page.is_honeypot,
      s.total, s.correct, s.ambiguous, s.incorrect
    FROM page
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE correctness = 'correct')::int AS correct,
        count(*) FILTER (WHERE correctness = 'ambiguous')::int AS ambiguous,
        count(*) FILTER (WHERE correctness = 'incorrect')::int AS incorrect
      FROM samples
      WHERE challenge_id = page.id
        AND started_at >= page.generated_at - interval '1 hour'
        AND started_at <  page.generated_at + interval '6 hours'
    ) s ON true
    ORDER BY page.generated_at DESC
  `);
  return rows as unknown as ChallengeRow[];
}

/**
 * 10s cache, shared between the SSR call and the /api/challenges polling
 * route, so N concurrent polling clients on the same filter set = 1 DB query
 * per 10s, not N.
 */
export const fetchChallengeRows = unstable_cache(fetchChallengeRowsImpl, ["challengeRows"], {
  revalidate: 10,
});
