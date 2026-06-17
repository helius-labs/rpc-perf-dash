/**
 * On-demand one-shot benchmark CLI.
 *
 * Same flow as continuous mode minus the dispatch-via-DB step: generate fresh
 * challenges, fetch each one's AUDITOR reference from the utility endpoint, run
 * fanout+buildSampleRowsV2 (which decides consensus locally in the runner), and
 * print a ranked report.
 *
 *   pnpm benchmark
 *   pnpm benchmark --challenges 100
 *   pnpm benchmark --methods getBlock,getTransaction
 *   pnpm benchmark --buckets archival
 *   pnpm benchmark --concurrency 5
 *   pnpm benchmark --json
 *   pnpm benchmark --no-write
 */

import { sql } from "drizzle-orm";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  CONFIGURED_BENCHMARKED,
  METHODOLOGY_VERSION,
  UTILITY_PROVIDER,
  EMITTED_METHODS,
  assertAuditorIndependent,
  loadEnv,
  resolveEndpointUrl,
  score,
  DEFAULT_WEIGHTS,
  type Method,
  type ProviderRow,
} from "@rpcbench/shared";
import { HANDLERS } from "@rpcbench/methods";
import { paramsAsArray } from "./params.js";
import { createDb, insertConsensusLog, insertSamples, firstRow } from "@rpcbench/db";
import { fanout, fanoutTimeoutForBucket, buildSampleRowsV2, shouldArchive } from "@rpcbench/runner";
import { auditorCallOptsForBucket } from "./auditor.js";
import { createRpcClient } from "./rpc.js";
import { SlotObserver } from "./observe.js";
import { commitmentHash, generateSeed } from "./commit-reveal.js";
import { runLeaderboardPrecompute, runRollupTick } from "./rollup.js";

loadEnv(import.meta.url);

// The emitted set, plus the two dormant methods kept CLI-testable for
// re-validation (getSupply stays fully dormant). See @rpcbench/shared
// EMITTED_METHODS / DORMANT_METHODS and docs/methodology.md.
const VALID_METHODS: Method[] = [...EMITTED_METHODS, "getClusterNodes", "getLargestAccounts"];
const REGION = process.env.WORKER_REGION ?? "us-east-2";
const TICK_TIMEOUT_MS = 30_000;
const MAX_DERIVATION_RETRIES = 3;

interface CliArgs {
  challenges: number;
  methods: Method[];
  concurrency: number;
  json: boolean;
  noWrite: boolean;
  /** Substring filter on bucket names (e.g. "archival") — canary targeting. */
  buckets: string | null;
}

function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const { values } = parseArgs({
    args: argv,
    options: {
      challenges: { type: "string", default: "50" },
      methods: { type: "string" },
      concurrency: { type: "string", default: "3" },
      json: { type: "boolean", default: false },
      "no-write": { type: "boolean", default: false },
      buckets: { type: "string" },
    },
  });

  const challenges = Number.parseInt(values.challenges!, 10);
  if (!Number.isFinite(challenges) || challenges <= 0) {
    console.error("--challenges must be a positive integer");
    process.exit(2);
  }
  const concurrency = Number.parseInt(values.concurrency!, 10);
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    console.error("--concurrency must be a positive integer");
    process.exit(2);
  }
  let methods: Method[];
  if (values.methods) {
    const parts = values.methods.split(",").map((s) => s.trim()) as Method[];
    for (const m of parts) {
      if (!VALID_METHODS.includes(m)) {
        console.error(`unknown method: ${m}. valid: ${VALID_METHODS.join(",")}`);
        process.exit(2);
      }
    }
    methods = parts;
  } else {
    methods = [...VALID_METHODS];
  }
  let buckets = values.buckets ?? null;
  if (buckets !== null) {
    buckets = buckets.trim();
    // Drop methods with no bucket matching the filter so derivation attempts
    // aren't wasted on combos that can never match.
    methods = methods.filter((m) => HANDLERS[m].buckets.some((b) => b.includes(buckets!)));
    if (methods.length === 0) {
      console.error(`--buckets "${buckets}" matches no buckets on the selected methods`);
      process.exit(2);
    }
  }
  return {
    challenges,
    methods,
    concurrency,
    json: values.json === true,
    noWrite: values["no-write"] === true,
    buckets,
  };
}

function utilityClient() {
  if (!UTILITY_PROVIDER) throw new Error("UTILITY_PROVIDER missing");
  const ep = UTILITY_PROVIDER.endpoints[0];
  if (!ep) throw new Error("Utility provider has no endpoints");
  const url = resolveEndpointUrl(ep);
  if (!url) throw new Error("UTILITY_RPC_URL not set in env");
  return createRpcClient(url, 10_000);
}

interface ChallengeOutcome {
  status: "consensus" | "ambiguous" | "derivation_failed";
  challenge_id?: string;
  method?: Method;
  bucket?: string;
}

async function runOneChallenge(opts: {
  db: ReturnType<typeof createDb>;
  observer: SlotObserver;
  utility: ReturnType<typeof utilityClient>;
  secret: string;
  methods: readonly Method[];
  noWrite: boolean;
  runId: string;
  bucketsFilter: string | null;
  collectedRows: { rows: import("@rpcbench/db").SampleRow[] };
}): Promise<ChallengeOutcome> {
  const { db, observer, utility, secret, methods, noWrite, runId, bucketsFilter, collectedRows } = opts;

  // Pick a (method, bucket) combo. Retry derivation up to 3 times if the
  // handler returns null for the picked bucket.
  let derived: { params: unknown; bucket: string } | null = null;
  let chosenMethod: Method | null = null;
  for (let attempt = 0; attempt < MAX_DERIVATION_RETRIES; attempt++) {
    const m = methods[Math.floor(Math.random() * methods.length)]!;
    const buckets = bucketsFilter
      ? HANDLERS[m].buckets.filter((x) => x.includes(bucketsFilter))
      : HANDLERS[m].buckets;
    if (buckets.length === 0) continue;
    const b = buckets[Math.floor(Math.random() * buckets.length)]!;
    const r = await HANDLERS[m].deriveChallenge({
      recentSlots: observer.recentSlots(),
      utility,
      method: m,
      bucket: b,
    });
    if (r) {
      derived = r;
      chosenMethod = m;
      break;
    }
  }
  if (!derived || !chosenMethod) {
    return { status: "derivation_failed" };
  }

  const method: Method = chosenMethod;
  const params = paramsAsArray(method, derived.params);
  const seed = generateSeed(secret, observer.tipSlot(), Date.now());
  const cHash = commitmentHash(seed, params);
  const startedAt = new Date();

  // Auditor reference (utility endpoint). Empty fallback when unavailable —
  // the runner will mark each sample's exclusion_reason as auditor_unavailable.
  // Note: the multi-endpoint client in continuous mode auto-fails-over; here
  // we're using the single-endpoint createRpcClient, so a transient utility
  // hiccup will simply land in the "auditor_unavailable" branch.
  const auditorRef = await (async () => {
    try {
      const response = await utility.call(method, params, auditorCallOptsForBucket(derived.bucket));
      const projection = HANDLERS[method].project(response);
      return {
        response,
        hash: Buffer.from(projection.hash),
        tip_slot: observer.tipSlot(),
      };
    } catch {
      return null;
    }
  })();

  const referenceForRow = auditorRef ?? {
    response: null,
    hash: Buffer.alloc(0),
    tip_slot: observer.tipSlot(),
  };

  // Insert ready challenge (consensus model: no pending_quorum phase). Direct SQL because
  // the CLI is single-process and doesn't go through the createReadyChallenge
  // fan-out path (no assignments — the CLI is its own vantage).
  const row = await firstRow<{ id: string }>(
    db,
    sql`
    INSERT INTO challenges (
      method, params, bucket, commitment_hash,
      generated_at, expires_at, methodology_version, status, is_honeypot, run_id,
      reference_response, reference_hash, reference_tip_slot,
      seed, seed_revealed_at
    ) VALUES (
      ${method}, ${JSON.stringify(params)}::jsonb, ${derived.bucket},
      ${cHash}::bytea,
      now(), now() + interval '30 seconds', ${METHODOLOGY_VERSION},
      'ready', false, ${runId}::uuid,
      ${JSON.stringify(referenceForRow.response)}::jsonb,
      ${referenceForRow.hash}::bytea,
      ${referenceForRow.tip_slot.toString()}::bigint,
      ${seed}::bytea, now()
    )
    RETURNING id::text AS id
  `,
  );
  if (!row) throw new Error("insert ready challenge: no id");
  const challenge_id = row.id;

  // Fanout to benchmarked providers (bucket-aware timeout, same as workers).
  const { results, provider_tip_slots } = await fanout(method, params, {
    timeoutMs: fanoutTimeoutForBucket(derived.bucket),
  });

  const built = buildSampleRowsV2({
    challenge_id,
    method,
    bucket: derived.bucket,
    worker_provider: "benchmark-cli",
    region: REGION,
    worker_id: "benchmark-cli",
    egress_path: "benchmark-cli",
    reference_hash: referenceForRow.hash,
    reference_response: referenceForRow.response,
    reference_tip_slot: referenceForRow.tip_slot,
    is_honeypot: false,
    archive: shouldArchive(challenge_id),
    fanoutResults: results,
    provider_tip_slots,
    startedAt,
  });

  collectedRows.rows.push(...built.rows);
  if (!noWrite && built.rows.length > 0) {
    await insertSamples(db, built.rows);
    for (const log of built.consensus_log) await insertConsensusLog(db, log);
  }

  // Determine the outcome status — if both modes were ambiguous, report
  // "ambiguous" for the run summary. Otherwise "consensus" (at least one
  // mode reached consensus).
  const anyConsensus = built.consensus_log.some((l) => l.decision === "consensus");
  // If we wrote no logs (selective: only disputed/ambiguous/archive get
  // logged), assume consensus (the happy path).
  const status: ChallengeOutcome["status"] =
    built.consensus_log.length === 0 || anyConsensus ? "consensus" : "ambiguous";
  return { status, challenge_id, method, bucket: derived.bucket };
}

interface ProviderAggregate {
  provider_id: string;
  name: string;
  n_total: number;
  n_correct: number;
  p50_cold: number | null;
  p95_cold: number | null;
  p99_cold: number | null;
  p50_warm: number | null;
  p95_warm: number | null;
  p99_warm: number | null;
  success_rate: number;
  correctness_rate: number;
  freshness_p95_lag: number | null;
  n_wins: number;
  n_challenges_with_winner: number;
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = p * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

function aggregate(rows: readonly import("@rpcbench/db").SampleRow[]): ProviderAggregate[] {
  const byProvider = new Map<string, import("@rpcbench/db").SampleRow[]>();
  for (const r of rows) {
    const arr = byProvider.get(r.provider_id) ?? [];
    arr.push(r);
    byProvider.set(r.provider_id, arr);
  }

  const winsByProvider = new Map<string, number>();
  const challengeBest = new Map<string, { provider_id: string; latency_ms: number }>();
  for (const r of rows) {
    if (r.connection_mode !== "cold" || r.correctness !== "correct") continue;
    const cur = challengeBest.get(r.challenge_id);
    if (!cur || r.latency_ms < cur.latency_ms) {
      challengeBest.set(r.challenge_id, { provider_id: r.provider_id, latency_ms: r.latency_ms });
    }
  }
  for (const { provider_id } of challengeBest.values()) {
    winsByProvider.set(provider_id, (winsByProvider.get(provider_id) ?? 0) + 1);
  }
  const totalChallengesWithWinner = challengeBest.size;

  const out: ProviderAggregate[] = [];
  const benchmarked: ProviderRow[] = CONFIGURED_BENCHMARKED();
  for (const provider of benchmarked) {
    const list = byProvider.get(provider.id) ?? [];
    const cold = list.filter((r) => r.connection_mode === "cold" && r.correctness === "correct");
    const warm = list.filter((r) => r.connection_mode === "warm" && r.correctness === "correct");
    const sortedColdLat = cold.map((r) => r.latency_ms).sort((a, b) => a - b);
    const sortedWarmLat = warm.map((r) => r.latency_ms).sort((a, b) => a - b);
    const correctRows = list.filter((r) => r.correctness === "correct");
    const okRows = list.filter((r) => r.status === "ok" && r.correctness !== "ambiguous");
    const validatedRows = list.filter((r) => r.correctness === "correct" || r.correctness === "incorrect" || r.correctness === "stale");
    const lagSorted = correctRows
      .map((r) => Number(r.freshness_lag ?? 0n))
      .sort((a, b) => a - b);

    out.push({
      provider_id: provider.id,
      name: provider.name,
      n_total: list.length,
      n_correct: correctRows.length,
      p50_cold: percentile(sortedColdLat, 0.5),
      p95_cold: percentile(sortedColdLat, 0.95),
      p99_cold: percentile(sortedColdLat, 0.99),
      p50_warm: percentile(sortedWarmLat, 0.5),
      p95_warm: percentile(sortedWarmLat, 0.95),
      p99_warm: percentile(sortedWarmLat, 0.99),
      success_rate: list.length === 0 ? 0 : okRows.length / list.length,
      correctness_rate: validatedRows.length === 0 ? 0 : correctRows.length / validatedRows.length,
      freshness_p95_lag: percentile(lagSorted, 0.95),
      n_wins: winsByProvider.get(provider.id) ?? 0,
      n_challenges_with_winner: totalChallengesWithWinner,
    });
  }
  return out;
}

function fmtMs(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n)}ms`;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function printText(opts: {
  startedAt: Date;
  runId: string;
  totalChallenges: number;
  consensus: number;
  ambiguous: number;
  derivationFailed: number;
  region: string;
  aggregates: ProviderAggregate[];
  scored: ReturnType<typeof score>;
  wallClockMs: number;
  samplesWritten: number;
  noWrite: boolean;
}): void {
  const sep = "=".repeat(80);
  console.log("");
  console.log("Solana RPC Benchmark — one-shot run");
  console.log(sep);
  console.log(`Run started: ${opts.startedAt.toISOString()}`);
  console.log(
    `Challenges:  ${opts.totalChallenges}  (${opts.consensus} consensus, ${opts.ambiguous} ambiguous, ${opts.derivationFailed} derivation_failed)`,
  );
  console.log(`Region:      ${opts.region}`);
  console.log("");

  const header =
    pad("Provider", 14) +
    " | " +
    rpad("p50 cold", 9) +
    " | " +
    rpad("p95 cold", 9) +
    " | " +
    rpad("p50 warm", 9) +
    " | " +
    rpad("p95 warm", 9) +
    " | " +
    rpad("n", 4) +
    " | " +
    rpad("correct%", 8) +
    " | " +
    rpad("score", 6);
  console.log(header);
  console.log("-".repeat(header.length));

  const scoreById = new Map(opts.scored.map((s) => [s.provider_id, s]));
  const sortedAggs = [...opts.aggregates].sort((a, b) => {
    const sa = scoreById.get(a.provider_id)?.total ?? -1;
    const sb = scoreById.get(b.provider_id)?.total ?? -1;
    return sb - sa;
  });

  for (const a of sortedAggs) {
    const s = scoreById.get(a.provider_id);
    const scoreCol = s ? s.total.toFixed(1) : "ineligible";
    console.log(
      pad(a.name, 14) +
        " | " +
        rpad(fmtMs(a.p50_cold), 9) +
        " | " +
        rpad(fmtMs(a.p95_cold), 9) +
        " | " +
        rpad(fmtMs(a.p50_warm), 9) +
        " | " +
        rpad(fmtMs(a.p95_warm), 9) +
        " | " +
        rpad(String(a.n_total), 4) +
        " | " +
        rpad(`${(a.correctness_rate * 100).toFixed(1)}%`, 8) +
        " | " +
        rpad(scoreCol, 6),
    );
  }

  console.log("");
  const w = DEFAULT_WEIGHTS;
  console.log(
    `Score weights: ${w.latency} latency · ${w.winRate} win-rate · ${w.reliability} reliability · ${w.correctness} correctness · ${w.freshness} freshness`,
  );
  const elapsedSec = opts.wallClockMs / 1000;
  const m = Math.floor(elapsedSec / 60);
  const s = Math.round(elapsedSec - m * 60);
  console.log(`Wall-clock:    ${m}m ${s}s`);
  console.log(`Samples written to Neon: ${opts.noWrite ? "0 (--no-write)" : opts.samplesWritten}`);
  console.log(sep);
}

function printJson(opts: {
  startedAt: Date;
  runId: string;
  totalChallenges: number;
  consensus: number;
  ambiguous: number;
  derivationFailed: number;
  region: string;
  aggregates: ProviderAggregate[];
  scored: ReturnType<typeof score>;
  wallClockMs: number;
  samplesWritten: number;
  noWrite: boolean;
  challengeIds: string[];
}): void {
  const scoreById = new Map(opts.scored.map((s) => [s.provider_id, s]));
  const out = {
    run_id: opts.runId,
    run_started_at: opts.startedAt.toISOString(),
    challenges_total: opts.totalChallenges,
    challenges_consensus: opts.consensus,
    challenges_ambiguous: opts.ambiguous,
    challenges_derivation_failed: opts.derivationFailed,
    region: opts.region,
    methodology_version: METHODOLOGY_VERSION,
    score_weights: DEFAULT_WEIGHTS,
    wall_clock_ms: opts.wallClockMs,
    samples_written: opts.noWrite ? 0 : opts.samplesWritten,
    no_write: opts.noWrite,
    challenge_ids: opts.challengeIds,
    providers: opts.aggregates.map((a) => ({
      ...a,
      score: scoreById.get(a.provider_id) ?? null,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
}

async function checkContinuousRunning(db: ReturnType<typeof createDb>): Promise<boolean> {
  try {
    const row = await firstRow<{ fresh: boolean }>(
      db,
      sql`SELECT (now() - beat_at) < interval '30 seconds' AS fresh FROM generator_heartbeat`,
    );
    return row?.fresh === true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseCliArgs();
  const secret = process.env.GENERATOR_SECRET;
  if (!secret) {
    console.error("GENERATOR_SECRET not set");
    process.exit(2);
  }

  // Fail-closed on misconfigured auditor — same guarantee as the continuous
  // generator. The cross-check is the integrity story; we don't want the CLI
  // silently scoring against a non-independent reference.
  assertAuditorIndependent();

  const db = createDb({ mode: "direct" });

  if (await checkContinuousRunning(db)) {
    console.error(
      "[benchmark] note: a continuous generator appears to be running (recent heartbeat). The one-shot will add load on top — its samples will still feed the dashboard.",
    );
  }

  const utility = utilityClient();
  const observer = new SlotObserver(utility);
  observer.start();
  await new Promise((r) => setTimeout(r, 1500));

  const runId = randomUUID();
  if (!args.json) {
    console.error(
      `[benchmark] run_id=${runId}\n[benchmark] running ${args.challenges} challenges across ${args.methods.join("+")} at concurrency=${args.concurrency} ...`,
    );
  }

  const collectedRows = { rows: [] as import("@rpcbench/db").SampleRow[] };
  const outcomes: ChallengeOutcome[] = [];
  const startedAt = new Date();

  let inFlight = 0;
  let dispatched = 0;
  let completed = 0;
  await new Promise<void>((resolve) => {
    const tickDone = () => {
      if (completed >= args.challenges) resolve();
      else dispatchAsMany();
    };
    const dispatchAsMany = () => {
      while (inFlight < args.concurrency && dispatched < args.challenges) {
        dispatched++;
        inFlight++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TICK_TIMEOUT_MS);
        runOneChallenge({
          db,
          observer,
          utility,
          secret,
          methods: args.methods,
          noWrite: args.noWrite,
          runId,
          bucketsFilter: args.buckets,
          collectedRows,
        })
          .then((outcome) => {
            outcomes.push(outcome);
          })
          .catch((err) => {
            outcomes.push({ status: "derivation_failed" });
            if (!args.json) console.error("[benchmark] challenge error:", (err as Error).message);
          })
          .finally(() => {
            clearTimeout(timer);
            inFlight--;
            completed++;
            if (!args.json && completed % 5 === 0) {
              console.error(`[benchmark] ${completed}/${args.challenges} challenges done`);
            }
            tickDone();
          });
      }
    };
    dispatchAsMany();
  });

  observer.stop();
  const wallClockMs = Date.now() - startedAt.getTime();

  // Refresh rollups + eligibility so the web dashboard picks up the run.
  // Skipped on --no-write since there are no DB rows to roll up.
  if (!args.noWrite) {
    if (!args.json) console.error("[benchmark] refreshing rollups + eligibility ...");
    try {
      // The recurring generator runs these on independent intervals; the
      // one-shot CLI runs them back-to-back so the run lands on both the chart
      // (rollups_5m) and the >24h leaderboard before we print results.
      await runRollupTick(db);
      await runLeaderboardPrecompute(db);
    } catch (err) {
      if (!args.json) console.error("[benchmark] rollup refresh failed:", (err as Error).message);
    }
  }

  const aggregates = aggregate(collectedRows.rows);
  const eligible = aggregates.filter(
    (a) => a.n_correct > 0 && a.p95_cold !== null && a.p50_cold !== null,
  );
  const scored = score(
    eligible.map((a) => ({
      provider_id: a.provider_id,
      p50_latency_ms: a.p50_cold!,
      p95_latency_ms: a.p95_cold!,
      success_rate: a.success_rate,
      correct_count: a.n_correct,
      validated_count: a.n_correct,
      freshness_p95_lag: a.freshness_p95_lag ?? 1,
      n_wins: a.n_wins,
      n_challenges_with_winner: a.n_challenges_with_winner,
    })),
  );

  const consensusCount = outcomes.filter((o) => o.status === "consensus").length;
  const ambiguousCount = outcomes.filter((o) => o.status === "ambiguous").length;
  const derivationFailed = outcomes.filter((o) => o.status === "derivation_failed").length;
  const challengeIds = outcomes
    .map((o) => o.challenge_id)
    .filter((id): id is string => typeof id === "string");

  const reportInput = {
    startedAt,
    runId,
    totalChallenges: outcomes.length,
    consensus: consensusCount,
    ambiguous: ambiguousCount,
    derivationFailed,
    region: REGION,
    aggregates,
    scored,
    wallClockMs,
    samplesWritten: collectedRows.rows.length,
    noWrite: args.noWrite,
  };

  if (args.json) {
    printJson({ ...reportInput, challengeIds });
  } else {
    printText(reportInput);
    console.log(`Run ID:        ${runId}`);
    console.log(`View on web:   https://rpc-perf-dash.vercel.app/run/${runId}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[benchmark] fatal", err);
  process.exit(1);
});
