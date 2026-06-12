/**
 * Daily rollup of consensus_log decisions — feeds the Performance page's
 * "Consensus integrity" panel. Extracted from app/page.tsx.
 *
 * Three numbers per day:
 *   - no_consensus       : panel couldn't agree (samples dropped)
 *   - disputed           : panel agreed but the auditor disagreed (samples dropped)
 *   - auditor_unavailable : panel agreed; auditor down (samples kept, flagged)
 * Lower is better on all three. consensus_log writes are selective (disputed +
 * ambiguous + 1% archive), so the absolute counts are a sample, not the full
 * traffic; ratios remain meaningful.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";

export interface ConsensusRate {
  day: string;
  total: number;
  no_consensus: number;
  disputed: number;
  auditor_unavailable: number;
}

const CACHE_TTL_S = 30;

async function fetchConsensusRatesImpl(): Promise<ConsensusRate[]> {
  const rows = await db().execute(sql`
    SELECT
      to_char(date_trunc('day', decided_at), 'YYYY-MM-DD')                 AS day,
      count(*)::int                                                        AS total,
      count(*) FILTER (WHERE decision = 'ambiguous')::int                  AS no_consensus,
      count(*) FILTER (WHERE auditor_verdict = 'disputed')::int            AS disputed,
      count(*) FILTER (WHERE auditor_verdict = 'auditor_unavailable')::int AS auditor_unavailable
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
