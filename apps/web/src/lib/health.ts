/**
 * Fleet-health snapshot fetcher — benchmarked providers, the independent
 * auditor, and the infra vantages. Extracted from app/page.tsx so both the
 * Overview (slim health pill) and the Performance page (full ProviderHealth
 * strip) read one cached copy.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";
import type {
  BenchmarkedHealth,
  InfraVantageHealth,
  AuditorHealth,
} from "@/lib/healthTypes";

export interface ProviderHealthSnapshot {
  benchmarked: BenchmarkedHealth[];
  auditor: AuditorHealth;
  infra: InfraVantageHealth[];
}

/** Cache TTL — matches the generator's 30s tick, same as the other fetchers. */
const CACHE_TTL_S = 30;

async function fetchProviderHealthImpl(): Promise<ProviderHealthSnapshot> {
  const benchRows = await db().execute(sql`
    SELECT
      provider_id,
      count(*)::int                                       AS n_samples,
      count(*) FILTER (WHERE correctness = 'correct')::int AS n_correct,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE correctness = 'correct')::int        AS p95_ms,
      max(started_at)                                      AS latest
    FROM samples
    WHERE started_at > now() - interval '15 min'
      AND provider_id IN (SELECT id FROM providers WHERE benchmarked = true)
    GROUP BY provider_id
  `);
  // Auditor (utility endpoint) health: how recently any endpoint succeeded,
  // and the worst circuit_state across the failover chain. The dashboard
  // surfaces this so an auditor outage is visible (the consensus cross-check
  // is the dashboard's integrity story — silent auditor downtime would mean
  // we're scoring on consensus alone without flagging it).
  const auditorRows = await db().execute(sql`
    SELECT
      max(last_ok_at)                                                       AS last_ok_at,
      bool_or(circuit_state = 'open')                                       AS any_open,
      bool_or(circuit_state = 'closed' AND last_ok_at > now() - interval '2 min') AS any_healthy
    FROM utility_rpc_status
  `);
  const auditorRow = (auditorRows as unknown as Array<{
    last_ok_at: string | Date | null;
    any_open: boolean | null;
    any_healthy: boolean | null;
  }>)[0];
  // Consensus-accuracy headline number — % of finalized challenges that the
  // deferred re-verification job confirmed against the consensus reference.
  // 90-day window so a fresh deploy still reads as N/A (NULL) instead of 100%.
  const auditAccRows = await db().execute(sql`
    SELECT
      count(*) FILTER (WHERE matched = true)::int  AS matched,
      count(*) FILTER (WHERE matched IS NOT NULL)::int AS total
    FROM consensus_audit
    WHERE audited_at > now() - interval '90 days'
  `);
  const auditAcc = (auditAccRows as unknown as Array<{ matched: number; total: number }>)[0];

  // Infra vantage health — one card per (worker_provider, region, egress_path)
  // currently heartbeating (5 min window). Joins heartbeat staleness against
  // sample throughput so a vantage that's "alive but not getting work" surfaces
  // as degraded.
  //
  // Sample throughput is computed per WORKER_ID, not per (provider, region,
  // egress_path) triple — Cloudflare actively migrates a lane's container
  // between PoPs while keeping its identity. Counting samples by triple
  // produced a misleading "yellow flicker" for ~60-90s after every CF
  // migration: the new PoP card had a fresh heartbeat but 0 samples (because
  // the lane's recent samples were tagged with the old PoP), so it rendered
  // as degraded. Counting by worker_id makes the card track the lane, not
  // the PoP — accurate for "is this lane productive?" semantics.
  //
  // For AWS / TSW / GCP / Latitude (none migrate), worker_id is 1:1 with the
  // triple so the join produces identical results as the old triple-keyed
  // version. Sample-row-level aggregations elsewhere in the FE still use
  // samples.region directly, so geographic accounting is unaffected.
  const infraRows = await db().execute(sql`
    WITH vantages AS (
      SELECT DISTINCT worker_provider, region, egress_path
      FROM worker_heartbeat
      WHERE beat_at > now() - interval '5 minutes'
    ),
    latest_hb AS (
      -- Latest heartbeat per (provider, region, egress_path), plus the
      -- worker_id behind that heartbeat so we can attribute samples to it.
      SELECT DISTINCT ON (worker_provider, region, egress_path)
             worker_provider, region, egress_path, worker_id, beat_at
      FROM worker_heartbeat
      ORDER BY worker_provider, region, egress_path, beat_at DESC
    ),
    sample_stats AS (
      SELECT worker_id,
             count(*)::int       AS n_samples_15m,
             max(started_at)     AS latest_sample_at
      FROM samples
      WHERE started_at > now() - interval '15 min'
      GROUP BY worker_id
    )
    SELECT
      v.worker_provider,
      v.region,
      v.egress_path,
      lh.beat_at,
      extract(epoch from now() - lh.beat_at)::int AS staleness_s,
      coalesce(ss.n_samples_15m, 0) AS n_samples_15m,
      ss.latest_sample_at
    FROM vantages v
    LEFT JOIN latest_hb    lh ON (lh.worker_provider, lh.region, lh.egress_path) = (v.worker_provider, v.region, v.egress_path)
    LEFT JOIN sample_stats ss ON ss.worker_id = lh.worker_id
    ORDER BY v.worker_provider, v.region, v.egress_path
  `);

  return {
    benchmarked: benchRows as unknown as BenchmarkedHealth[],
    auditor: {
      last_ok_at: auditorRow?.last_ok_at ?? null,
      healthy: auditorRow?.any_healthy === true,
      any_open: auditorRow?.any_open === true,
      consensus_accuracy_pct:
        auditAcc && auditAcc.total > 0 ? (auditAcc.matched / auditAcc.total) * 100 : null,
      consensus_audited_n: auditAcc?.total ?? 0,
    },
    infra: infraRows as unknown as InfraVantageHealth[],
  };
}

export const fetchProviderHealth = unstable_cache(
  fetchProviderHealthImpl,
  ["fetchProviderHealth"],
  { revalidate: CACHE_TTL_S },
);
