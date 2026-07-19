/**
 * Standalone, zero-infra RPC benchmark CLI.
 *
 * Brings your own endpoints (`--provider name=url`), generates its own
 * challenges, fans out to your endpoints, decides correctness in-memory (panel
 * consensus, or vs a `--reference` node), and renders a live table — no DB, no
 * secret, no auditor-independence requirement.
 *
 *   pnpm --filter cli start -- --provider a=https://... --provider b=https://...
 *   pnpm --filter cli start -- --provider a=https://... --challenges 50 --json
 *   pnpm --filter cli start -- --provider a=https://... --reference https://trusted
 *   pnpm --filter cli start -- --provider a=... --methods getBlock,getTransaction
 *   pnpm --filter cli start -- --provider a=... --buckets archival
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { HANDLERS } from "@rpcbench/methods";
import { buildSampleRows } from "@rpcbench/runner/record";
import { redactEndpointUrl, score, type Method } from "@rpcbench/shared";
import type { SampleRow } from "@rpcbench/db";

import { createRpcClient } from "./rpc.js";
import { SlotObserver } from "./observe.js";
import { paramsAsArray } from "./params.js";
import { fanout, fanoutTimeoutForBucket, type BenchProvider } from "./fanout.js";
import { parseConfig, type CliConfig } from "./config.js";
import { pickMethods } from "./pick.js";
import { aggregate, toMetrics } from "./aggregate.js";
import { determineRegime, type Regime } from "./mode.js";
import { LiveRenderer, printFinalReport, printJson, type RunState } from "./render.js";

const MAX_DERIVATION_RETRIES = 3;
const CHALLENGE_TIMEOUT_MS = 30_000;

type OutcomeStatus = "consensus" | "ambiguous" | "derivation_failed";

interface ReferenceAnswer {
  response: unknown;
  hash: Buffer;
  tip_slot: bigint;
}

/** One per-challenge audit record for --dump — exactly what was compared. */
interface DumpRecord {
  challenge_id: string;
  method: string;
  bucket: string;
  params: unknown;
  reference_hash: string | null;
  endpoints: Array<{
    name: string;
    connection_mode: string;
    status: string;
    http_status: number | null;
    latency_ms: number | null;
    correctness: string;
    exclusion_reason: string | null;
    response_hash: string | null;
    error_code: string | null;
  }>;
  consensus: Array<{ connection_mode: string; decision: string; decision_reason: string | null }>;
}

const toHex = (b: unknown): string | null =>
  b == null ? null : Buffer.from(b as Uint8Array).toString("hex") || null;

/** Small seeded PRNG (mulberry32) — installed as Math.random under --seed so the
 *  method/bucket picks AND the handlers' slot/target derivation are reproducible
 *  (given the same chain tip). */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a (method, bucket), derive, fanout, build rows. Returns outcome status. */
async function runOneChallenge(ctx: {
  config: CliConfig;
  regime: Regime;
  utility: ReturnType<typeof createRpcClient>;
  observer: SlotObserver;
  providers: readonly BenchProvider[];
  collected: SampleRow[];
  dump: DumpRecord[] | null;
}): Promise<OutcomeStatus> {
  const { config, regime, utility, observer, providers, collected, dump } = ctx;

  // Choose a (method, bucket) combo, retrying derivation on null.
  let derived: { params: unknown; bucket: string } | null = null;
  let chosenMethod: Method | null = null;
  for (let attempt = 0; attempt < MAX_DERIVATION_RETRIES; attempt++) {
    const m = config.methods[Math.floor(Math.random() * config.methods.length)]!;
    const buckets = config.buckets
      ? HANDLERS[m].buckets.filter((b) => b.includes(config.buckets!))
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
  if (!derived || !chosenMethod) return "derivation_failed";

  const method = chosenMethod;
  const bucket = derived.bucket;
  const params = paramsAsArray(method, derived.params);
  const startedAt = new Date();
  const timeoutMs = fanoutTimeoutForBucket(bucket);

  // vs-reference mode: fetch the trusted node's answer and score every endpoint
  // against it (as a honeypot known-answer). Without it, correctness is decided
  // by panel consensus and no reference is fetched.
  let reference: ReferenceAnswer | null = null;
  if (regime.useReference) {
    try {
      const response = await utility.call(method, params, { timeoutMs });
      const projection = HANDLERS[method].project(response);
      reference = {
        response,
        hash: Buffer.from(projection.hash),
        tip_slot: observer.tipSlot(),
      };
    } catch {
      // Reference unavailable → we can't score this challenge honestly; skip it.
      return "ambiguous";
    }
  }

  const { results, provider_tip_slots } = await fanout(method, params, providers, { timeoutMs });

  const built = buildSampleRows({
    challenge_id: randomUUID(),
    method,
    bucket,
    worker_provider: "cli",
    region: "local",
    worker_id: "cli",
    egress_path: "cli",
    reference_hash: reference ? reference.hash : Buffer.alloc(0),
    reference_response: reference ? reference.response : null,
    reference_tip_slot: reference ? reference.tip_slot : observer.tipSlot(),
    is_honeypot: regime.useReference,
    archive: false,
    fanoutResults: results,
    provider_tip_slots,
    startedAt,
  });

  collected.push(...built.rows);

  if (dump) {
    const nameById = new Map(providers.map((p) => [p.id, p.name]));
    dump.push({
      challenge_id: built.rows[0]?.challenge_id ?? randomUUID(),
      method,
      bucket,
      params,
      reference_hash: reference ? reference.hash.toString("hex") : null,
      endpoints: built.rows.map((r) => ({
        name: nameById.get(r.provider_id) ?? r.provider_id,
        connection_mode: r.connection_mode,
        status: r.status,
        http_status: r.http_status ?? null,
        latency_ms: r.latency_ms ?? null,
        correctness: r.correctness,
        exclusion_reason: r.exclusion_reason ?? null,
        response_hash: toHex(r.response_hash),
        error_code: r.error_code ?? null,
      })),
      consensus: built.consensus_log.map((l) => ({
        connection_mode: l.connection_mode,
        decision: l.decision,
        decision_reason: l.decision_reason ?? null,
      })),
    });
  }

  if (regime.useReference) return "consensus"; // scored vs reference
  const anyConsensus = built.consensus_log.some((l) => l.decision === "consensus");
  return built.consensus_log.length === 0 || anyConsensus ? "consensus" : "ambiguous";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("challenge timeout")), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));

  // --seed: install a deterministic PRNG so method/bucket picks and the handlers'
  // slot/target derivation reproduce across runs (given the same chain tip).
  if (config.seed != null) {
    Math.random = seededRandom(config.seed);
  }

  // Interactive method picker. Launches by default on a TTY when the user didn't
  // pass --methods (so you pick with arrow keys instead of flag syntax); --pick
  // forces it even alongside --methods. Skipped for --json / piped stdin, where
  // it falls back to the resolved --methods / all-methods default.
  if (!config.json && process.stdin.isTTY && (config.pick || !config.hasExplicitMethods)) {
    config.methods = await pickMethods(config.methods);
  }

  const providers = config.providers;

  const referenceUrl = config.referenceUrl ?? providers[0]!.url;
  const referenceLabel = redactEndpointUrl(referenceUrl);
  const regime = determineRegime(config, referenceLabel);

  // The reference client doubles as the challenge-derivation source. In
  // consensus mode that's the first user endpoint (fine — derivation only needs
  // a working RPC to find real slots/txs; it doesn't bias latency).
  const utility = createRpcClient(referenceUrl, 10_000);
  const observer = new SlotObserver(utility);
  observer.start();

  if (!config.json) {
    console.error(
      `[bench] ${providers.length} endpoint(s): ${providers.map((p) => p.name).join(", ")}`,
    );
    console.error(`[bench] ${regime.label}`);
    console.error(
      `[bench] ${config.challenges} challenges · concurrency ${config.concurrency} · warming slot observer...`,
    );
  }
  await new Promise((r) => setTimeout(r, 1500));

  const collected: SampleRow[] = [];
  const dump: DumpRecord[] | null = config.dump ? [] : null;
  const state: RunState = {
    done: 0,
    total: config.challenges,
    consensus: 0,
    ambiguous: 0,
    derivationFailed: 0,
  };
  const live = new LiveRenderer();
  const startedAt = new Date();
  const runStartMs = Date.now();

  const render = (): void => {
    if (config.json) return;
    const aggs = aggregate(collected, providers);
    const scored = score(toMetrics(aggs));
    live.update(aggs, scored, state);
  };

  let dispatched = 0;
  let inFlight = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (state.done >= config.challenges) {
        resolve();
        return;
      }
      while (inFlight < config.concurrency && dispatched < config.challenges) {
        dispatched++;
        inFlight++;
        withTimeout(
          runOneChallenge({ config, regime, utility, observer, providers, collected, dump }),
          CHALLENGE_TIMEOUT_MS,
        )
          .then((status) => {
            if (status === "consensus") state.consensus++;
            else if (status === "ambiguous") state.ambiguous++;
            else state.derivationFailed++;
          })
          .catch(() => {
            state.derivationFailed++;
          })
          .finally(() => {
            inFlight--;
            state.done++;
            render();
            if (config.json && state.done % 10 === 0) {
              console.error(`[bench] ${state.done}/${config.challenges} done`);
            }
            pump();
          });
      }
    };
    pump();
  });

  observer.stop();
  const wallClockMs = Date.now() - runStartMs;

  const aggregates = aggregate(collected, providers);
  const scored = score(toMetrics(aggregates));

  if (config.json) {
    printJson({
      aggregates,
      scored,
      state,
      mode: regime.mode,
      modeLabel: regime.label,
      wallClockMs,
      startedAt,
      methods: config.methods,
    });
  } else {
    printFinalReport({ aggregates, scored, state, modeLabel: regime.label, wallClockMs, startedAt });
  }

  if (config.dump && dump) {
    writeFileSync(
      config.dump,
      JSON.stringify(
        {
          run_started_at: startedAt.toISOString(),
          vantage: "local",
          correctness_mode: regime.mode,
          seed: config.seed,
          challenges: dump,
        },
        null,
        2,
      ),
    );
    console.error(`[bench] wrote ${dump.length}-challenge audit trail to ${config.dump}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[bench] fatal", err);
  process.exit(1);
});
