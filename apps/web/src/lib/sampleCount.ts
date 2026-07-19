/**
 * All-time sample count + recent rate, for the Overview's live counter.
 *
 * Counting the multi-million-row `samples` table every few seconds is too
 * expensive, so we read the retained leaderboard precompute instead:
 *   - total    : Σ sample_count_total over the grain='1d' rows (compact, monotonic)
 *   - ratePerSec: recent samples/sec — last hour if active, else the 24h average
 *     (smoother and more resilient to brief gaps), from the grain='1h' rows.
 *
 * Scoped to the pooled-infra sentinel (`__all__`) so each sample is counted
 * once (not once per infra). All samples count, regardless of when they were
 * recorded — a sample is a sample. The frontend extrapolates total at
 * ratePerSec so the number ticks up live between the ~30s re-syncs.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { POOLED_INFRA } from "@rpcbench/shared";
import { db } from "@/lib/db";

export interface SampleCount {
  /** Total samples recorded (this methodology version), all time. */
  total: number;
  /** Recent samples-per-second, used to extrapolate the counter client-side. */
  ratePerSec: number;
}

export const EMPTY_SAMPLE_COUNT: SampleCount = { total: 0, ratePerSec: 0 };

async function fetchSampleCountImpl(): Promise<SampleCount> {
  const rows = await db().execute(sql`
    SELECT
      (SELECT coalesce(sum(sample_count_total), 0)::bigint
         FROM leaderboard_agg
        WHERE grain = '1d'
          AND worker_provider = ${POOLED_INFRA}
          AND provider_id IN (SELECT id FROM providers WHERE benchmarked = true)) AS total,
      (SELECT coalesce(sum(sample_count_total), 0)::bigint
         FROM leaderboard_agg
        WHERE grain = '1h'
          AND worker_provider = ${POOLED_INFRA}
          AND provider_id IN (SELECT id FROM providers WHERE benchmarked = true)
          AND window_start > now() - interval '60 minutes')                       AS last_hour,
      (SELECT coalesce(sum(sample_count_total), 0)::bigint
         FROM leaderboard_agg
        WHERE grain = '1h'
          AND worker_provider = ${POOLED_INFRA}
          AND provider_id IN (SELECT id FROM providers WHERE benchmarked = true)
          AND window_start > now() - interval '24 hours')                         AS last_day
  `);
  const r = (rows as unknown as Array<{ total: string | number; last_hour: string | number; last_day: string | number }>)[0];
  const total = Number(r?.total ?? 0);
  const lastHour = Number(r?.last_hour ?? 0);
  const lastDay = Number(r?.last_day ?? 0);
  // Prefer the live last-hour rate; fall back to the 24h average so the counter
  // still ticks when the most recent hour is momentarily empty.
  const ratePerSec = lastHour > 0 ? lastHour / 3600 : lastDay > 0 ? lastDay / 86_400 : 0;
  return { total, ratePerSec };
}

export const fetchSampleCount = unstable_cache(fetchSampleCountImpl, ["fetchSampleCount"], {
  revalidate: 10,
});
