/**
 * Fleet-health snapshot fetcher — benchmarked providers, the utility endpoint,
 * and the infra vantages. Extracted from app/page.tsx so both the Overview
 * (slim health pill) and the Performance page (full ProviderHealth strip) read
 * one cached copy.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { MIN_CONSENSUS_VOTERS } from "@rpcbench/shared";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import { db } from "@/lib/db";
import type {
  BenchmarkedHealth,
  InfraVantageHealth,
  UtilityHealth,
} from "@/lib/healthTypes";

export interface ProviderHealthSnapshot {
  benchmarked: BenchmarkedHealth[];
  utility: UtilityHealth;
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
  // Utility endpoint health: how recently any endpoint succeeded, and the worst
  // circuit_state across the failover chain. Surfaced so an outage of the
  // generator's chain-observation RPC (no challenges get derived) is visible.
  const utilityRows = await db().execute(sql`
    SELECT
      max(last_ok_at)                                                       AS last_ok_at,
      bool_or(circuit_state = 'open')                                       AS any_open,
      bool_or(circuit_state = 'closed' AND last_ok_at > now() - interval '2 min') AS any_healthy
    FROM utility_rpc_status
  `);
  const utilityRow = (utilityRows as unknown as Array<{
    last_ok_at: string | Date | null;
    any_open: boolean | null;
    any_healthy: boolean | null;
  }>)[0];

  // Infra vantage health — one card per (worker_provider, region, egress_path)
  // currently heartbeating (5 min window). Joins heartbeat staleness against
  // sample throughput so a vantage that's "alive but not getting work" surfaces
  // as degraded.
  //
  // Sample throughput is computed per WORKER_ID, not per (provider, region,
  // egress_path) triple — Cloudflare actively migrates a lane's container
  // between PoPs while keeping its identity. Counting samples by triple would
  // mislead right after a CF migration: the new PoP card has a fresh heartbeat
  // but 0 samples (the lane's recent samples are tagged with the old PoP), so
  // it would render as degraded. Counting by worker_id makes the card track the
  // lane, not the PoP — accurate for "is this lane productive?" semantics.
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
    utility: {
      last_ok_at: utilityRow?.last_ok_at ?? null,
      healthy: utilityRow?.any_healthy === true,
      any_open: utilityRow?.any_open === true,
    },
    infra: infraRows as unknown as InfraVantageHealth[],
  };
}

export const fetchProviderHealth = unstable_cache(
  fetchProviderHealthImpl,
  ["fetchProviderHealth"],
  { revalidate: CACHE_TTL_S },
);

/**
 * Consensus health for the degraded banner. The benchmark needs
 * >= MIN_CONSENSUS_VOTERS (3) usable providers to reach consensus; if fewer are
 * reporting, every method falls to `no_consensus` and the rankings silently
 * stop updating (and getBlock's full block bodies flood the DB). This surfaces
 * that as one banner with the WHY per down provider, so "alchemy out of credits
 * / quicknode endpoint down" is obvious instead of a quiet red dot.
 *
 * Light, self-contained query (15m benchmarked-only, no infra/utility subqueries)
 * + a dominant-failure `mode()` so the banner can name the reason. Resilient:
 * any error returns a non-degraded result so the banner never breaks a page.
 */
export interface ConsensusHealth {
  /** Providers currently reporting (status ok|degraded) — i.e. usable voters. */
  usable: number;
  /** Total benchmarked providers in the panel. */
  total: number;
  /** Consensus floor (MIN_CONSENSUS_VOTERS). */
  minVoters: number;
  /** True when usable < minVoters — rankings can't reach consensus. */
  degraded: boolean;
  /** The down/absent providers with a human reason ("out of credits", …). */
  down: { id: string; name: string; reason: string }[];
}

// Failure categories that mean the provider's response did NOT project — i.e.
// it is NOT a usable consensus voter (it errored out). A provider whose
// dominant failure is `no_consensus` is the opposite: it IS responding with a
// valid, parseable answer and only turns no_consensus once OTHER providers drop
// below the voter minimum — so it must not be counted as down, or the banner
// would blame the victims instead of the culprits (alchemy/quicknode today).
const NOT_USABLE_FAILURES = new Set([
  "quota_exhausted",
  "network_error",
  "http_error",
  "network_timeout",
  "rpc_error",
]);

/** Map a down provider's dominant failure to a short human reason. */
function consensusReason(absent: boolean, topFailure: string | null): string {
  if (absent) return "no recent samples";
  switch (topFailure) {
    case "quota_exhausted":
      return "out of credits";
    case "network_error":
    case "http_error":
    case "network_timeout":
      return "endpoint down";
    case "rpc_error":
      return "RPC errors";
    default:
      return topFailure ? topFailure.replace(/_/g, " ") : "failing";
  }
}

async function fetchConsensusHealthImpl(): Promise<ConsensusHealth> {
  const total = BENCHMARKED_PROVIDERS.filter((p) => p.benchmarked).length;
  const base: ConsensusHealth = {
    usable: total,
    total,
    minVoters: MIN_CONSENSUS_VOTERS,
    degraded: false,
    down: [],
  };
  try {
    const rows = (await db().execute(sql`
      SELECT
        provider_id,
        count(*)::int                                        AS n_samples,
        count(*) FILTER (WHERE correctness = 'correct')::int AS n_correct,
        mode() WITHIN GROUP (ORDER BY failure_category)
          FILTER (WHERE correctness <> 'correct' AND failure_category IS NOT NULL) AS top_failure
      FROM samples
      WHERE started_at > now() - interval '15 min'
        AND provider_id IN (SELECT id FROM providers WHERE benchmarked = true)
      GROUP BY provider_id
    `)) as unknown as {
      provider_id: string;
      n_samples: number;
      n_correct: number;
      top_failure: string | null;
    }[];
    const byId = new Map(rows.map((r) => [r.provider_id, r]));

    let usable = 0;
    const down: ConsensusHealth["down"] = [];
    for (const p of BENCHMARKED_PROVIDERS.filter((b) => b.benchmarked)) {
      const r = byId.get(p.id);
      const nSamples = r?.n_samples ?? 0;
      const top = r?.top_failure ?? null;
      const absent = nSamples === 0;
      // A provider is a usable voter unless it produced no samples at all, or
      // it produced zero correct samples AND its dominant failure is an
      // infra/quota error (it errored out rather than returning a parseable
      // answer). `no_consensus` providers stay "usable" — they're the victims.
      const notUsable = absent || ((r?.n_correct ?? 0) === 0 && top !== null && NOT_USABLE_FAILURES.has(top));
      if (!notUsable) usable += 1;
      else down.push({ id: p.id, name: p.name, reason: consensusReason(absent, top) });
    }
    return { usable, total, minVoters: MIN_CONSENSUS_VOTERS, degraded: usable < MIN_CONSENSUS_VOTERS, down };
  } catch {
    // Never let the banner's own fetch break a page; pages surface DB errors
    // through their primary queries.
    return base;
  }
}

export const fetchConsensusHealth = unstable_cache(
  fetchConsensusHealthImpl,
  ["fetchConsensusHealth"],
  { revalidate: CACHE_TTL_S },
);
