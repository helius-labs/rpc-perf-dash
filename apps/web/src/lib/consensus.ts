/**
 * Daily rollup of consensus_log decisions — feeds the Performance page's
 * "Consensus integrity" panel. Extracted from app/page.tsx.
 *
 * Per day:
 *   - no_consensus : panel couldn't agree (samples dropped)
 * Lower is better. consensus_log writes are selective (ambiguous + 1% archive),
 * so the absolute counts are a sample, not the full traffic; ratios remain
 * meaningful.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";

export interface ConsensusRate {
  day: string;
  total: number;
  no_consensus: number;
}

const CACHE_TTL_S = 30;

async function fetchConsensusRatesImpl(): Promise<ConsensusRate[]> {
  const rows = await db().execute(sql`
    SELECT
      to_char(date_trunc('day', decided_at), 'YYYY-MM-DD')                 AS day,
      count(*)::int                                                        AS total,
      count(*) FILTER (WHERE decision = 'ambiguous')::int                  AS no_consensus
    FROM consensus_log
    WHERE decided_at > now() - interval '14 days'
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  return rows as unknown as ConsensusRate[];
}

export const fetchConsensusRates = unstable_cache(
  fetchConsensusRatesImpl,
  ["fetchConsensusRates"],
  { revalidate: CACHE_TTL_S },
);
