/**
 * Server-side fetcher for the /challenges page's SENDS board — the actual
 * transactions broadcast by the send lane, read from `landing_tx_results`
 * (append-only, one final row per signature). This is the send analogue of
 * lib/challengeRows.ts; the two are toggled by the page's `board` filter.
 *
 * Client-safe types / filter parsing live in lib/challengeFilters.ts.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import { SEND_METHODOLOGY_VERSION } from "@rpcbench/shared";
import { PAGE_SIZE, type ChallengesFilters } from "@/lib/challengeFilters";

export interface SendTxnRow {
  /** Signature — globally unique per landed/attempted tx; used as the row key. */
  id: string;
  signature: string;
  send_target: string;
  scenario: string;
  worker_provider: string;
  region: string;
  outcome: string;
  slot_latency: number | null;
  wall_latency_ms: number | null;
  started_at: string | Date;
}

/** WHERE for the send-txn row + count queries (scenario / outcome / window / signature). */
function sendWhere(f: ChallengesFilters) {
  const conds = [
    sql`started_at > now() - make_interval(hours => ${f.window})`,
    sql`methodology_version = ${SEND_METHODOLOGY_VERSION}`,
    f.scenario ? sql`scenario = ${f.scenario}` : null,
    f.outcome ? sql`outcome = ${f.outcome}` : null,
    f.target
      ? sql`(signature ILIKE ${"%" + f.target + "%"} OR pool_address ILIKE ${"%" + f.target + "%"})`
      : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);
  return sql`WHERE ${sql.join(conds, sql` AND `)}`;
}

async function fetchSendTxnRowsImpl(f: ChallengesFilters): Promise<SendTxnRow[]> {
  const rows = await db().execute(sql`
    SELECT
      signature AS id,
      signature,
      send_target,
      scenario,
      worker_provider,
      region,
      outcome,
      slot_latency,
      wall_latency_ms,
      started_at
    FROM landing_tx_results
    ${sendWhere(f)}
    ORDER BY started_at DESC
    LIMIT ${PAGE_SIZE} OFFSET ${f.offset}
  `);
  return rows as unknown as SendTxnRow[];
}
export const fetchSendTxnRows = unstable_cache(fetchSendTxnRowsImpl, ["sendTxnRows"], {
  revalidate: 10,
});

async function fetchSendTxnCountImpl(f: ChallengesFilters): Promise<number> {
  const rows = await db().execute(
    sql`SELECT count(*)::int AS n FROM landing_tx_results ${sendWhere(f)}`,
  );
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}
export const fetchSendTxnCount = unstable_cache(fetchSendTxnCountImpl, ["sendTxnCount"], {
  revalidate: 15,
});

/** Scenario vocabulary for the dropdown — distinct scenarios present in the window. */
async function fetchScenarioOptionsImpl(window: number): Promise<string[]> {
  const rows = await db().execute(sql`
    SELECT DISTINCT scenario FROM landing_tx_results
    WHERE started_at > now() - make_interval(hours => ${window})
      AND methodology_version = ${SEND_METHODOLOGY_VERSION}
    ORDER BY scenario
  `);
  return (rows as unknown as Array<{ scenario: string }>).map((r) => r.scenario);
}
export const fetchScenarioOptions = unstable_cache(fetchScenarioOptionsImpl, ["sendScenarios"], {
  revalidate: 30,
});
