/**
 * Head-to-head (A-vs-B) win rate, read from the `pairwise_wins` precompute.
 *
 * The pure win-rate math lives in `@rpcbench/shared` (computeHeadToHead) so it's
 * unit-tested in the shared harness; this file wraps it with the DB query +
 * request cache. "Overall" region-blends the per-geo rates; a specific region is
 * a single-geo passthrough.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import {
  METHODOLOGY_VERSION,
  leaderboardGrainForWindow,
  computeHeadToHead,
  type ConnectionMode,
  type GeoRegion,
  type HeadToHeadResult,
  type Method,
  type PairwiseGeoRow,
} from "@rpcbench/shared";
import { db } from "@/lib/db";
import { CACHE_TTL_S } from "@/lib/leaderboard";

interface FetchArgs {
  /** Lexicographically smaller / larger provider id (canonical pair order). */
  providerA: string;
  providerB: string;
  method: Method;
  connectionMode: ConnectionMode;
  windowHours: number;
  region: GeoRegion | "overall";
}

async function fetchHeadToHeadImpl(args: FetchArgs): Promise<HeadToHeadResult> {
  const { providerA, providerB, method, connectionMode, windowHours, region } = args;
  const grain = leaderboardGrainForWindow(windowHours);
  const geoClause = region === "overall" ? sql`` : sql`AND geo = ${region}`;
  const rows = (await db().execute(sql`
    SELECT geo,
      COALESCE(sum(a_wins), 0)::int      AS a_wins,
      COALESCE(sum(b_wins), 0)::int      AS b_wins,
      COALESCE(sum(n_contested), 0)::int AS n_contested
    FROM pairwise_wins
    WHERE grain = ${grain} AND provider_a = ${providerA} AND provider_b = ${providerB}
      AND method = ${method} AND connection_mode = ${connectionMode}
      AND methodology_version = ${METHODOLOGY_VERSION}
      AND window_start > now() - make_interval(hours => ${windowHours})
      ${geoClause}
    GROUP BY geo
  `)) as unknown as PairwiseGeoRow[];
  return computeHeadToHead(rows);
}

/**
 * Cached on the same 30s tick as the other read fetchers, keyed on the
 * normalized args (unstable_cache hashes them), so concurrent hits for the same
 * pair coalesce onto one DB read.
 */
export const fetchHeadToHead = unstable_cache(fetchHeadToHeadImpl, ["api-head-to-head"], {
  revalidate: CACHE_TTL_S,
});
