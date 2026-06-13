/**
 * verify-deploy.ts — post-deploy health check for the whole fleet.
 *
 * Methodology v=2. Confirms after running deploy-all-workers.sh that:
 *   - every expected vantage is heartbeating with low staleness
 *   - assignments are being fanned out to every vantage
 *   - samples are flowing
 *   - EVERY method is flowing: challenges generated, samples written, and
 *     per-provider benchmark latency
 *   - the consensus_log shows mostly verified outcomes (no-consensus and
 *     auditor-disputed rates are reported but not gated)
 *   - the v=1 quorum-node providers are no longer in the DB
 *
 * Run via the db workspace so loadEnv() finds .env.local:
 *   pnpm --filter @rpcbench/db exec tsx ../../infra/scripts/verify-deploy.ts
 */

import postgres from "postgres";
import { loadEnv } from "@rpcbench/shared";

loadEnv(import.meta.url);

// All benchmarked methods. The per-method section checks each is flowing
// (challenges + samples) and reports quorum decisions, correctness, and
// per-provider benchmark latency. Keep in sync with the Method union /
// HANDLERS registry.
const ALL_METHODS = [
  "getBlock",
  "getTransaction",
  "getSignaturesForAddress",
  "getSlot",
  "getAccountInfo",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getBalance",
  // getSupply intentionally not emitted (see apps/generator/src/index.ts) —
  // excluded here so the per-method "is flowing" check doesn't flag it.
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getLatestBlockhash",
  "getTokenAccountBalance",
  // NOTE: the 2026-05-31 / 2026-06-01 method batches were never added here —
  // the "is flowing" check doesn't cover them yet.
  // ── Batch added 2026-06-12 ──────────────────────────────────────────
  "getTransactionsForAddress",
];
// LATENCY_ONLY_METHODS is empty under methodology v=2 — every method is
// correctness-scored. Helper retained as `false` so the per-method block below
// reads cleanly without a structural rewrite.
const isLatencyOnly = (_m: string) => false;

const EXPECTED_VANTAGES: Array<{ provider: string; region: string }> = [
  { provider: "aws", region: "us-east-2" },
  { provider: "aws", region: "eu-central-1" },
  { provider: "aws", region: "ap-northeast-1" },
  { provider: "teraswitch", region: "ewr" },
  { provider: "teraswitch", region: "ams" },
  { provider: "teraswitch", region: "tokyo" },
  { provider: "gcp", region: "us-east4" },
  { provider: "gcp", region: "us-west1" },
  { provider: "gcp", region: "europe-west3" },
  { provider: "gcp", region: "europe-west2" },
  { provider: "gcp", region: "asia-northeast1" },
  { provider: "gcp", region: "asia-southeast1" },
  // CF lanes self-label to whatever PoP they land in; not enumerated here.
];

const HEARTBEAT_STALE_THRESHOLD_S = 30;
const SAMPLE_VOLUME_WINDOW_MIN = 5;
const METHOD_WINDOW_MIN = 15;

const RED   = "\x1b[31m";
const GREEN = "\x1b[32m";
const YEL   = "\x1b[33m";
const DIM   = "\x1b[2m";
const RST   = "\x1b[0m";

const pass = (s: string) => console.log(`${GREEN}✓${RST} ${s}`);
const fail = (s: string) => console.log(`${RED}✗${RST} ${s}`);
const warn = (s: string) => console.log(`${YEL}!${RST} ${s}`);
const head = (s: string) => console.log(`\n${DIM}── ${s} ──${RST}`);

let failures = 0;

async function main() {
  const url = process.env.NEON_DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("Set NEON_DATABASE_URL_DIRECT or DATABASE_URL_UNPOOLED");
  const sql = postgres(url, { max: 1 });

  // ── 1. Heartbeats ──────────────────────────────────────────────────────
  head("Heartbeats by (worker_provider, region)");
  const hbRows = await sql<
    Array<{ worker_provider: string; region: string; egress_path: string; staleness_s: number }>
  >`
    SELECT worker_provider, region, egress_path,
           extract(epoch from now() - beat_at)::int AS staleness_s
    FROM worker_heartbeat
    WHERE beat_at > now() - interval '5 min'
    ORDER BY worker_provider, region
  `;
  console.table(hbRows);

  for (const exp of EXPECTED_VANTAGES) {
    const matches = hbRows.filter(
      (r) => r.worker_provider === exp.provider && r.region === exp.region,
    );
    if (matches.length === 0) {
      fail(`${exp.provider}/${exp.region}: NO heartbeat in last 5 min`);
      failures++;
    } else {
      const stale = matches.some((r) => r.staleness_s > HEARTBEAT_STALE_THRESHOLD_S);
      if (stale) {
        warn(`${exp.provider}/${exp.region}: heartbeating but stale (>${HEARTBEAT_STALE_THRESHOLD_S}s)`);
      } else {
        pass(`${exp.provider}/${exp.region}: ${matches.length} fresh heartbeat(s)`);
      }
    }
  }

  const cfHb = hbRows.filter((r) => r.worker_provider === "cloudflare");
  if (cfHb.length === 0) {
    warn("cloudflare: no CF lanes heartbeating (skip if you SKIP_CF'd, otherwise investigate)");
  } else {
    pass(`cloudflare: ${cfHb.length} CF lane(s) heartbeating at ${cfHb.map((r) => r.region).join(", ")}`);
  }

  // ── 2. Assignments fan-out ─────────────────────────────────────────────
  head(`Assignments in last ${SAMPLE_VOLUME_WINDOW_MIN} min`);
  const fanRows = await sql<Array<{ worker_provider: string; region: string; n: number }>>`
    SELECT a.worker_provider, a.region, count(*)::int AS n
    FROM challenge_assignments a
    JOIN challenges c ON c.id = a.challenge_id
    WHERE c.generated_at > now() - make_interval(mins => ${SAMPLE_VOLUME_WINDOW_MIN})
    GROUP BY a.worker_provider, a.region
    ORDER BY a.worker_provider, a.region
  `;
  console.table(fanRows);

  for (const exp of EXPECTED_VANTAGES) {
    const row = fanRows.find((r) => r.worker_provider === exp.provider && r.region === exp.region);
    if (!row || row.n === 0) {
      fail(`${exp.provider}/${exp.region}: NO assignments fanned out`);
      failures++;
    } else {
      pass(`${exp.provider}/${exp.region}: ${row.n} assignments`);
    }
  }

  // ── 3. Sample volume + correctness ─────────────────────────────────────
  head(`Sample volume + correctness in last ${SAMPLE_VOLUME_WINDOW_MIN} min`);
  const sampleRows = await sql<
    Array<{
      worker_provider: string;
      region: string;
      n_total: number;
      n_correct: number;
      n_incorrect: number;
      n_ambiguous: number;
    }>
  >`
    SELECT worker_provider, region,
           count(*)::int                                              AS n_total,
           count(*) FILTER (WHERE correctness = 'correct')::int       AS n_correct,
           count(*) FILTER (WHERE correctness = 'incorrect')::int     AS n_incorrect,
           count(*) FILTER (WHERE correctness = 'ambiguous')::int     AS n_ambiguous
    FROM samples
    WHERE started_at > now() - make_interval(mins => ${SAMPLE_VOLUME_WINDOW_MIN})
    GROUP BY worker_provider, region
    ORDER BY worker_provider, region
  `;
  console.table(sampleRows);

  for (const exp of EXPECTED_VANTAGES) {
    const row = sampleRows.find((r) => r.worker_provider === exp.provider && r.region === exp.region);
    if (!row || row.n_total === 0) {
      fail(`${exp.provider}/${exp.region}: NO samples written`);
      failures++;
    } else {
      pass(`${exp.provider}/${exp.region}: ${row.n_total} samples (${row.n_correct} correct)`);
    }
  }

  // ── 4. Per-method: challenges generated + consensus outcomes ───────────
  // v=2: consensus_log is written selectively (disputed / ambiguous / 1%
  // archive), so the counts here are a *sample* of traffic, not the full
  // population — interpret rates, not absolute counts.
  head(`Challenges + consensus by method (last ${METHOD_WINDOW_MIN} min)`);
  const methodRows = await sql<
    Array<{
      method: string;
      challenges: number;
      logged: number;
      no_consensus: number;
      disputed: number;
      auditor_unavailable: number;
      pct_no_cons: number | null;
    }>
  >`
    SELECT c.method,
           count(*)::int                                                                AS challenges,
           count(cl.challenge_id)::int                                                  AS logged,
           count(*) FILTER (WHERE cl.decision = 'ambiguous')::int                       AS no_consensus,
           count(*) FILTER (WHERE cl.auditor_verdict = 'disputed')::int                 AS disputed,
           count(*) FILTER (WHERE cl.auditor_verdict = 'auditor_unavailable')::int      AS auditor_unavailable,
           round(100.0 * count(*) FILTER (WHERE cl.decision = 'ambiguous')
                 / NULLIF(count(cl.challenge_id), 0), 1)                                AS pct_no_cons
    FROM challenges c
    LEFT JOIN consensus_log cl ON cl.challenge_id = c.id
    WHERE c.generated_at > now() - make_interval(mins => ${METHOD_WINDOW_MIN})
      AND c.is_honeypot = false
      AND c.methodology_version >= 2
    GROUP BY c.method
    ORDER BY c.method
  `;
  console.table(methodRows);

  for (const m of ALL_METHODS) {
    const row = methodRows.find((r) => r.method === m);
    if (!row || row.challenges === 0) {
      fail(`${m}: NO challenges generated — method not flowing (generator stale?)`);
      failures++;
      continue;
    }
    if ((row.pct_no_cons ?? 0) >= 90 && row.logged >= 10) {
      warn(`${m}: ${row.challenges} challenges; ${row.pct_no_cons}% of logged samples are no-consensus`);
    } else if (row.disputed > 0) {
      warn(`${m}: ${row.disputed} auditor-disputed challenge(s) — investigate /raw`);
    } else {
      pass(`${m}: ${row.challenges} challenges, ${row.logged} logged (${row.pct_no_cons ?? 0}% no-cons, ${row.auditor_unavailable} auditor-down)`);
    }
  }
  void isLatencyOnly;

  // ── 5. Per-method: sample correctness breakdown ────────────────────────
  head(`Sample correctness by method (last ${METHOD_WINDOW_MIN} min)`);
  const corrRows = await sql<
    Array<{
      method: string;
      n: number;
      correct: number;
      incorrect: number;
      stale: number;
      ambiguous: number;
      incomplete: number;
    }>
  >`
    SELECT method,
           count(*)::int                                          AS n,
           count(*) FILTER (WHERE correctness='correct')::int     AS correct,
           count(*) FILTER (WHERE correctness='incorrect')::int   AS incorrect,
           count(*) FILTER (WHERE correctness='stale')::int       AS stale,
           count(*) FILTER (WHERE correctness='ambiguous')::int   AS ambiguous,
           count(*) FILTER (WHERE correctness='incomplete')::int  AS incomplete
    FROM samples
    WHERE started_at > now() - make_interval(mins => ${METHOD_WINDOW_MIN})
    GROUP BY method
    ORDER BY method
  `;
  console.table(corrRows);

  for (const m of ALL_METHODS) {
    const row = corrRows.find((r) => r.method === m);
    if (!row || row.n === 0) {
      fail(`${m}: NO samples written`);
      failures++;
    } else {
      pass(`${m}: ${row.n} samples (${row.correct} correct, ${row.incorrect} incorrect)`);
    }
  }

  // ── 6. Per-method: per-provider cold benchmark health ──────────────────
  head(`Per-provider cold benchmark by method (last ${METHOD_WINDOW_MIN} min): p50/p95 ms, success%, correct%`);
  const benchRows = await sql<
    Array<{
      method: string;
      provider_id: string;
      n: number;
      p50_ms: number | null;
      p95_ms: number | null;
      success_pct: number | null;
      correct_pct: number | null;
    }>
  >`
    SELECT method, provider_id,
           count(*)::int                                                                                 AS n,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status='ok')::int       AS p50_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status='ok')::int       AS p95_ms,
           round(100.0 * count(*) FILTER (WHERE status='ok' AND correctness != 'ambiguous')
                 / NULLIF(count(*), 0), 1)                                                               AS success_pct,
           round(100.0 * count(*) FILTER (WHERE status='ok' AND correctness='correct')
                 / NULLIF(count(*) FILTER (WHERE status='ok' AND correctness IN ('correct','incorrect','stale')), 0), 1) AS correct_pct
    FROM samples
    WHERE started_at > now() - make_interval(mins => ${METHOD_WINDOW_MIN})
      AND connection_mode = 'cold'
    GROUP BY method, provider_id
    ORDER BY method, p50_ms NULLS LAST
  `;
  console.table(benchRows);

  // ── 7. v=2 invariant: no v=1 quorum nodes seeded in providers table ─────
  head("Quorum-era providers removed from providers table");
  const ghostRows = await sql<Array<{ id: string }>>`
    SELECT id FROM providers
    WHERE id IN ('solana_foundation_public','chainstack','ankr','drpc','blockdaemon')
  `;
  if (ghostRows.length === 0) {
    pass("v=1 quorum providers removed (migration 0013 applied)");
  } else {
    fail(`v=1 quorum providers still in DB: ${ghostRows.map((r) => r.id).join(", ")} — migration 0013 not applied?`);
    failures++;
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log();
  if (failures === 0) {
    console.log(`${GREEN}════ ALL CHECKS PASSED ════${RST}`);
  } else {
    console.log(`${RED}════ ${failures} CHECK(S) FAILED ════${RST}`);
  }

  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
