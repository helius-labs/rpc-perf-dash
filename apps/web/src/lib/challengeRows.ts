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
 * re-runs only this — the count + bucket queries stay cached. The LATERAL
 * consensus counts use the per-challenge_id sample index (one lookup per row).
 */
async function fetchChallengeRowsImpl(f: ChallengesFilters): Promise<ChallengeRow[]> {
  const where = whereFor(f);
  const rows = await db().execute(sql`
    SELECT
      c.id::text AS id,
      c.method,
      c.bucket,
      c.status,
      c.generated_at,
      c.params,
      c.is_honeypot,
      s.total, s.correct, s.ambiguous, s.incorrect, s.disputed
    FROM challenges c
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE correctness = 'correct')::int AS correct,
        count(*) FILTER (WHERE correctness = 'ambiguous')::int AS ambiguous,
        count(*) FILTER (WHERE correctness = 'incorrect')::int AS incorrect,
        count(*) FILTER (WHERE exclusion_reason = 'consensus_disputed')::int AS disputed
      FROM samples WHERE challenge_id = c.id
    ) s ON true
    ${where}
    ORDER BY c.generated_at DESC
    LIMIT ${PAGE_SIZE} OFFSET ${f.offset}
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
