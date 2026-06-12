/**
 * Shared server-side fetcher for the "recent challenges" widget on the home
 * page + the `/api/recent-challenges` polling route. Same SQL, same shape,
 * single source of truth so SSR + client polling stay in sync.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";

export interface RecentChallenge {
  id: string;
  method: string;
  bucket: string;
  status: string;
  generated_at: string | Date;
  params: unknown;
  sample_count: number;
  // Derived per-challenge consensus counts. There's no challenge-level
  // "consensus reached" status — these aggregate the per-(vantage × mode)
  // sample outcomes into a single visual chip per row.
  consensus_correct: number;
  consensus_ambiguous: number;
  consensus_incorrect: number;
  consensus_disputed: number;
}

async function fetchRecentChallengesImpl(limit: number): Promise<RecentChallenge[]> {
  // LATERAL aggregate over samples derives the per-challenge consensus
  // outcome counts in a single index-driven lookup per row (uses
  // samples_challenge_idx). Cheaper than four scalar subqueries.
  const rows = await db().execute(sql`
    SELECT
      c.id::text             AS id,
      c.method,
      c.bucket,
      c.status,
      c.generated_at,
      c.params,
      s.total                AS sample_count,
      s.correct              AS consensus_correct,
      s.ambiguous            AS consensus_ambiguous,
      s.incorrect            AS consensus_incorrect,
      s.disputed             AS consensus_disputed
    FROM challenges c
    LEFT JOIN LATERAL (
      SELECT
        count(*)::int                                                                AS total,
        count(*) FILTER (WHERE correctness = 'correct')::int                          AS correct,
        count(*) FILTER (WHERE correctness = 'ambiguous')::int                        AS ambiguous,
        count(*) FILTER (WHERE correctness = 'incorrect')::int                        AS incorrect,
        count(*) FILTER (WHERE exclusion_reason = 'consensus_disputed')::int          AS disputed
      FROM samples WHERE challenge_id = c.id
    ) s ON true
    WHERE c.generated_at > now() - interval '1 hour'
    ORDER BY c.generated_at DESC
    LIMIT ${limit}
  `);
  return rows as unknown as RecentChallenge[];
}

/**
 * 10s cache. Tighter than the page-level 30s default so the client poll feels
 * fresh, but loose enough that N concurrent polling clients = 1 DB query per
 * 10s, not N queries.
 */
export const fetchRecentChallenges = unstable_cache(
  fetchRecentChallengesImpl,
  ["fetchRecentChallenges"],
  { revalidate: 10 },
);
