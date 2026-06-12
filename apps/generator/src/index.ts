import { sql } from "drizzle-orm";
import {
  METHODOLOGY_VERSION,
  UTILITY_PROVIDER,
  assertAuditorIndependent,
  loadEnv,
  resolveEndpointUrl,
  type Method,
} from "@rpcbench/shared";

// Load .env / .env.local from the repo root before anything reads process.env.
// Existing env values (e.g. from a `KEY=val` shell override or AWS Secrets
// Manager) take precedence.
loadEnv(import.meta.url);
import { HANDLERS } from "@rpcbench/methods";
import { paramsAsArray } from "./params.js";
import { createDb, createReadyChallenge, stashSeed } from "@rpcbench/db";
import { createUtilityClient, type MultiEndpointRpcClient } from "./utility-client.js";
import { SlotObserver } from "./observe.js";
import { fetchAuditorReference } from "./auditor.js";
import { drawHoneypot, shouldInjectHoneypot } from "./honeypot.js";
import { commitmentHash, generateSeed } from "./commit-reveal.js";
import {
  acquireLeader,
  evictAndAcquireLeader,
  writeHeartbeat,
} from "./heartbeat.js";
import { ensurePartitions } from "./partitions.js";
import { ensureProvidersSeeded } from "./seed-providers.js";
import {
  ROLLUP_INTERVAL_MS,
  runFinalityRecheck,
  runHeavyRollups,
  runLeaderboardPrecompute,
  runRollup5m,
} from "./rollup.js";

const VANTAGE_FRESHNESS_S = 60;
const TICK_INTERVAL_MS = 30_000;
// Hard ceiling on a single tick so one hung promise (DB socket, auditor HTTP,
// etc.) can't pin tickInFlight=true and starve the scheduler forever. The
// slack vs TICK_INTERVAL_MS guarantees the lock is released before the next
// tick fires.
const TICK_TIMEOUT_MS = 25_000;

/**
 * How many vantages each challenge is dispatched to. Fan-out used to be
 * "all active vantages" but that overshot worker claim throughput by ~3x —
 * the excess assignments expired unclaimed, never producing samples. K=3
 * matches dispatch (45 combos/tick × 3 = 135/tick = 270/min) under the
 * measured ~450/min worker claim rate with headroom for slow lanes.
 *
 * If |active vantages| < K, every vantage is selected (sampling is min(K, N)).
 *
 * Tradeoffs:
 *   - Each challenge is sampled by a smaller fraction of the fleet, so per-
 *     challenge cross-vantage win-rate has higher variance. Pooled long-
 *     window win-rate is unaffected (every vantage is sampled in
 *     expectation).
 *   - Per-(provider × method × region × 4h) sample count drops ~5x, still
 *     ~20-300x the eligibility floor.
 *   - Slow lanes (CF/lax) still mildly over capacity at K=3 uniform; Phase 2
 *     weighted sampling would close the residual.
 *
 * See docs/operations.md § K-sampling for the deeper rationale.
 */
const VANTAGE_SAMPLE_SIZE = 3;

/**
 * Skip a tick entirely if the unclaimed-assignment backlog is above this
 * threshold. Defensive: prevents a transient worker outage from compounding
 * into a 10k-row queue that workers can never drain inside the 30s TTL.
 *
 * Sized at ~1 minute of worker capacity (450/min × ~1.1 min). Should never
 * fire under K=3 healthy operation; only fires when something is wrong
 * (region down, generator just resumed after a long pause, etc.).
 */
const BACKPRESSURE_THRESHOLD = 500;

/**
 * Heartbeat-driven vantage registry. The set of (worker_provider, region,
 * egress_path) triples we fan challenges out to is whatever has heartbeated
 * in the last VANTAGE_FRESHNESS_S seconds — no hardcoded list. New vantages
 * bootstrap by deploying their worker; old ones drop out when they stop
 * heartbeating. See plan §B1b.
 *
 * Cached for the duration of a tick (refreshed at the start of each tick
 * loop iteration) so all per-combo fanouts in one tick agree on the same
 * vantage set.
 */
let _activeVantages: Array<{ worker_provider: string; region: string; egress_path: string }> = [];

async function refreshActiveVantages(db: ReturnType<typeof createDb>): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT worker_provider, region, egress_path
    FROM worker_heartbeat
    WHERE beat_at > now() - (${VANTAGE_FRESHNESS_S}::int || ' seconds')::interval
  `)) as unknown as Array<{ worker_provider: string; region: string; egress_path: string }>;
  _activeVantages = rows.map((r) => ({
    worker_provider: r.worker_provider,
    region: r.region,
    egress_path: r.egress_path,
  }));
}
const HEARTBEAT_INTERVAL_MS = 5_000;
const PARTITION_CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SEED_REVEAL_INTERVAL_MS = 60_000;
const EXPIRE_STALE_INTERVAL_MS = 60_000;

/**
 * Fisher-Yates partial shuffle: pick K random elements without replacement,
 * in O(K) without allocating beyond the result. Used to sample a subset of
 * vantages for each challenge — see VANTAGE_SAMPLE_SIZE.
 *
 * Returns a NEW array; the input is not mutated (we slice first).
 */
function sampleK<T>(arr: readonly T[], k: number): T[] {
  if (arr.length <= k) return [...arr];
  const result = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (result.length - i));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result.slice(0, k);
}

/**
 * Count assignments that are still claimable — unclaimed AND not yet past
 * their TTL. The back-pressure check uses this so a pile of zombie
 * assignments (past-TTL unclaimed left behind by an earlier outage) doesn't
 * freeze dispatch forever. Cleanup of those zombies is the job of
 * `expireStaleAssignments` below.
 */
async function countClaimableUnclaimed(
  db: ReturnType<typeof createDb>,
): Promise<number> {
  const r = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM challenge_assignments ca
    JOIN challenges c ON c.id = ca.challenge_id
    WHERE ca.status = 'unclaimed'
      AND c.expires_at > now()
  `)) as unknown as Array<{ n: number }>;
  return r[0]?.n ?? 0;
}

/**
 * Flip past-TTL unclaimed assignments to `expired`. Without this, workers
 * waste claim cycles on dead rows (claim → see expired → markDone → repeat),
 * and the back-pressure check can be fooled by a huge zombie backlog into
 * never dispatching. Runs every minute alongside `expireStaleChallenges`.
 */
async function expireStaleAssignments(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  await db.execute(sql`
    UPDATE challenge_assignments ca
    SET status = 'expired'
    FROM challenges c
    WHERE ca.challenge_id = c.id
      AND ca.status = 'unclaimed'
      AND c.expires_at < now() - interval '30 seconds'
  `);
}

/**
 * Flip ready challenges that are past their TTL with no samples to 'expired'.
 * Without this, stranded-unclaimed challenges read as 'ready' forever in the
 * UI — misleading. Runs every minute via setInterval below.
 *
 * Only expires rows that genuinely have no samples — a challenge with some
 * samples but past TTL is still a successful dispatch; we don't relabel those.
 */
async function expireStaleChallenges(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  await db.execute(sql`
    UPDATE challenges
    SET status = 'expired'
    WHERE status = 'ready'
      AND expires_at < now() - interval '30 seconds'
      AND NOT EXISTS (SELECT 1 FROM samples WHERE challenge_id = challenges.id)
  `);
}

function utilityClient(): MultiEndpointRpcClient {
  if (!UTILITY_PROVIDER) throw new Error("UTILITY_PROVIDER missing");
  // Resolve every configured slot. Filter out any whose env var is unset —
  // unset slots are deliberately optional so an operator can deploy with a
  // single endpoint, then add backups later by setting UTILITY_RPC_URL_2 /
  // UTILITY_RPC_URL_3 and redeploying.
  const specs = UTILITY_PROVIDER.endpoints
    .map((ep) => {
      const url = resolveEndpointUrl(ep);
      if (!url) return null;
      const m = /^env:(.+)$/.exec(ep.url);
      return { env_var: m?.[1] ?? "?", url };
    })
    .filter((x): x is { env_var: string; url: string } => x !== null);
  if (specs.length === 0) {
    throw new Error(
      "Utility/auditor provider has no resolvable endpoints — set UTILITY_RPC_URL at minimum",
    );
  }
  console.log(
    `[utility-client] ${specs.length} endpoint(s): ${specs.map((s) => s.env_var).join(", ")}`,
  );
  return createUtilityClient(specs, 5000);
}

function allMethodBucketCombos(): Array<{ method: Method; bucket: string }> {
  const methods: Method[] = [
    "getBlock",
    "getTransaction",
    "getSignaturesForAddress",
    "getSlot",
    "getAccountInfo",
    "getProgramAccounts",
    "getTokenAccountsByOwner",
    "getBalance",
    // getSupply is intentionally NOT emitted: on the current panel only triton
    // (~6s) and alchemy (~9s) compute it live and agree, quicknode serves a
    // stale cache, helius hangs >30s — so it can never reach the 3-voter
    // consensus minimum regardless of timeout. The handler is kept registered
    // (dormant) so any in-flight straggler resolves safely and it's trivial
    // to re-enable. See docs/methodology.md.
    "getTokenSupply",
    "getTokenLargestAccounts",
    "getLatestBlockhash",
    "getTokenAccountBalance",
    // ── Batch added 2026-05-31: 24 additional read methods. ──────────
    "getGenesisHash",
    "getEpochSchedule",
    "getInflationGovernor",
    "getInflationRate",
    "getBlockTime",
    "getBlockCommitment",
    "getBlocks",
    "getInflationReward",
    "getLeaderSchedule",
    "getBlockProduction",
    "getMaxRetransmitSlot",
    "getMaxShredInsertSlot",
    "getEpochInfo",
    "getBlockHeight",
    "getTransactionCount",
    "getVoteAccounts",
    "getRecentPerformanceSamples",
    "getIdentity",
    "getVersion",
    "getHealth",
    "isBlockhashValid",
    "getSlotLeader",
    "getSlotLeaders",
    "simulateTransaction",
    "simulateBundle",
    // ── Batch added 2026-06-01 ──────────────────────────────────────
    "getMultipleAccounts",
    "getSignatureStatuses",
    "getMinimumBalanceForRentExemption",
    "getStakeMinimumDelegation",
    "getBlocksWithLimit",
    "getRecentPrioritizationFees",
    "getFeeForMessage",
    // getClusterNodes and getLargestAccounts are intentionally NOT emitted
    // (dormant, like getSupply). Dry-run 2026-06-01: getLargestAccounts is
    // served only by QuickNode (Helius 500s, Triton rate-limits, Alchemy
    // blocks it) so it can never reach 3 voters; getClusterNodes' ~4576-node
    // payload only succeeds ~50% under fanout, so ≥3 voters rarely co-occur on
    // a challenge. Handlers stay registered; re-enable here if a future
    // panel/network converges. See docs/methodology.md.
  ];
  const out: Array<{ method: Method; bucket: string }> = [];
  for (const m of methods) {
    for (const b of HANDLERS[m].buckets) {
      out.push({ method: m, bucket: b });
    }
  }
  return out;
}

async function tickCombo(opts: {
  db: ReturnType<typeof createDb>;
  observer: SlotObserver;
  utility: ReturnType<typeof utilityClient>;
  secret: string;
  method: Method;
  bucket: string;
}): Promise<void> {
  const { method, bucket } = opts;

  // Honeypot vs fresh.
  if (await shouldInjectHoneypot()) {
    const hp = await drawHoneypot(opts.db, method);
    if (hp) {
      const seed = generateSeed(opts.secret, opts.observer.tipSlot(), Date.now());
      const cHash = commitmentHash(seed, hp.params);
      // Honeypots ship their pre-seeded known answer as the challenge's
      // reference; the worker's record.ts short-circuits the consensus path on
      // is_honeypot and classifies directly against this reference.
      const challengeId = await createReadyChallenge(
        opts.db,
        {
          method,
          params: hp.params,
          bucket: "honeypot",
          commitment_hash: cHash,
          ttl_seconds: 30,
          methodology_version: METHODOLOGY_VERSION,
          is_honeypot: true,
        },
        {
          response: hp.expected_projection,
          hash: hp.expected_projection_hash,
          tip_slot: opts.observer.tipSlot(),
        },
        // K-sampled vantage subset — see VANTAGE_SAMPLE_SIZE above.
        sampleK(_activeVantages, VANTAGE_SAMPLE_SIZE),
      );
      // Reveal seed for honeypot challenges immediately — they are pre-validated.
      await stashSeed(opts.db, challengeId, seed, "immediate");
      return;
    }
  }

  // Derive a fresh challenge.
  const handler = HANDLERS[method];
  const derived = await handler.deriveChallenge({
    recentSlots: opts.observer.recentSlots(),
    utility: opts.utility,
    method,
    bucket,
  });
  if (!derived) {
    return; // bucket couldn't be filled this tick; try next tick.
  }

  const seed = generateSeed(opts.secret, opts.observer.tipSlot(), Date.now());
  const params = paramsAsArray(method, derived.params);
  const cHash = commitmentHash(seed, params);

  // Capture the AUDITOR reference (utility endpoint). If unavailable, we
  // still dispatch the challenge — the worker marks each sample's
  // exclusion_reason as auditor_unavailable so the dashboard can surface the
  // audit-coverage gap, but scoring continues on consensus alone.
  const auditor = await fetchAuditorReference(opts.utility, method, params, opts.observer.tipSlot());

  const challengeId = await createReadyChallenge(
    opts.db,
    {
      method,
      params,
      bucket: derived.bucket,
      commitment_hash: cHash,
      ttl_seconds: 30,
      methodology_version: METHODOLOGY_VERSION,
      is_honeypot: false,
    },
    auditor ?? {
      response: null,
      hash: Buffer.alloc(0),
      tip_slot: opts.observer.tipSlot(),
    },
    // K-sampled vantage subset — see VANTAGE_SAMPLE_SIZE above.
    sampleK(_activeVantages, VANTAGE_SAMPLE_SIZE),
  );

  // Stash seed; reveal cron will publish it after expires_at.
  await stashSeed(opts.db, challengeId, seed, "after_expiry");
}

async function revealExpiredSeeds(db: ReturnType<typeof createDb>): Promise<void> {
  await db.execute(sql`
    UPDATE challenges
    SET seed_revealed_at = now()
    WHERE seed_revealed_at IS NULL
      AND expires_at < now()
      AND seed IS NOT NULL
  `);
}

async function main() {
  const secret = process.env.GENERATOR_SECRET;
  if (!secret) throw new Error("GENERATOR_SECRET not set");

  // Hard-fail at startup if the auditor's configured endpoints overlap with
  // any benchmarked provider — the consensus cross-check would not be
  // independent and the dashboard's integrity story would be hollow. The
  // assertion only catches host-string collisions; the operator is still on
  // the hook for confirming the configured endpoint's REAL operator is
  // independent of the panel (see methodology.md).
  assertAuditorIndependent();

  const db = createDb({ mode: "direct" });

  // Graceful shutdown — release the advisory lock instantly instead of
  // waiting for Neon's idle-session timeout.
  const shutdown = async (signal: string) => {
    console.log(`[generator] ${signal} received, shutting down`);
    try {
      await db.execute(sql.raw("SELECT pg_advisory_unlock_all()"));
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  let isLeader = await acquireLeader(db);
  while (!isLeader) {
    console.log("[generator] not leader, waiting for stale heartbeat...");
    await new Promise((r) => setTimeout(r, 15_000));
    isLeader = await evictAndAcquireLeader(db);
  }
  console.log(`[generator] acquired leader lock pid=${process.pid}`);

  const utility = utilityClient();
  const observer = new SlotObserver(utility);
  observer.start();

  // Seed the providers table (FK target for eligibility).
  console.log("[generator] seeding providers");
  await ensureProvidersSeeded(db);
  console.log("[generator] providers seeded");

  // Bootstrap partitions before any sample insert can happen.
  console.log("[generator] ensuring partitions");
  await ensurePartitions(db);
  console.log("[generator] partitions ok");
  setInterval(() => {
    ensurePartitions(db).catch((err) => console.error("[partitions]", err));
  }, PARTITION_CRON_INTERVAL_MS);

  setInterval(() => {
    writeHeartbeat(db).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(() => {
    revealExpiredSeeds(db).catch(() => {});
  }, SEED_REVEAL_INTERVAL_MS);

  // Flip stale ready→expired AND unclaimed→expired every minute. Without
  // these, K-sampling combined with the existing zombie backlog leaves
  // "ready" challenges + "unclaimed" assignments sitting around forever,
  // confusing the dashboard's recent-challenges view AND freezing dispatch
  // (back-pressure can be fooled into never dispatching by a huge zombie
  // queue).
  const runExpiry = () => {
    Promise.allSettled([
      expireStaleChallenges(db),
      expireStaleAssignments(db),
    ]).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[expire-stale]", (r.reason as Error).message);
        }
      }
    });
  };
  setInterval(runExpiry, EXPIRE_STALE_INTERVAL_MS);
  // Run once at startup so the existing backlog clears before the first
  // dispatch tick — otherwise the new generator's first tick sees a zombie
  // queue from before the deploy and back-pressure-skips forever.
  runExpiry();

  // Publish the utility-RPC client's per-endpoint health to the
  // `utility_rpc_status` table every 10s. The dashboard reads from there to
  // render the "Auditor" row in ProviderHealth so an upstream provider
  // going dark surfaces as a red dot immediately instead of a silent outage.
  const publishUtilityStatus = async () => {
    const snapshot = utility.getStatus();
    for (const s of snapshot) {
      await db.execute(sql`
        INSERT INTO utility_rpc_status (
          endpoint_index, url_label, last_ok_at, last_err_at, last_err_msg,
          consec_fails, circuit_state, updated_at
        )
        VALUES (
          ${s.endpoint_index}, ${s.url_label}, ${s.last_ok_at}, ${s.last_err_at},
          ${s.last_err_msg}, ${s.consec_fails}, ${s.circuit_state}, now()
        )
        ON CONFLICT (endpoint_index) DO UPDATE SET
          url_label     = EXCLUDED.url_label,
          last_ok_at    = EXCLUDED.last_ok_at,
          last_err_at   = EXCLUDED.last_err_at,
          last_err_msg  = EXCLUDED.last_err_msg,
          consec_fails  = EXCLUDED.consec_fails,
          circuit_state = EXCLUDED.circuit_state,
          updated_at    = now()
      `);
    }
  };
  // Fire-and-forget; errors are swallowed because the next interval cycle
  // will retry. This is observability state, not load-bearing data.
  setInterval(() => {
    publishUtilityStatus().catch((err) =>
      console.error("[utility-status]", (err as Error).message),
    );
  }, 10_000);
  // Run once immediately so the row exists for the dashboard's first read.
  await publishUtilityStatus().catch((err) =>
    console.error("[utility-status]", (err as Error).message),
  );

  // Liveness watchdog. The 2026-05-24 outage went 2 days undetected because
  // the heartbeat row + ECS health were both "fresh" while challenge insertion
  // was silently stalled. Treat "challenges flowing" as the real liveness
  // signal; if it stops for too long while we're leader, exit so ECS replaces
  // the task and alerts can fire on the restart.
  const WATCHDOG_INTERVAL_MS = 60_000;
  const WATCHDOG_STALE_THRESHOLD_MS = 5 * 60_000;
  setInterval(() => {
    (async () => {
      const r = (await db.execute(sql`
        SELECT count(*)::int AS n
        FROM challenges
        WHERE generated_at > now() - make_interval(secs => ${WATCHDOG_STALE_THRESHOLD_MS / 1000})
      `)) as unknown as Array<{ n: number }>;
      const n = r[0]?.n ?? 0;
      if (n === 0) {
        console.error(
          `[watchdog] no challenges inserted in the last ${WATCHDOG_STALE_THRESHOLD_MS / 1000}s — exiting so ECS restarts. ` +
            `Utility RPC status: ${JSON.stringify(utility.getStatus().map((s) => ({ idx: s.endpoint_index, state: s.circuit_state, consec_fails: s.consec_fails })))}`,
        );
        process.exit(1);
      }
    })().catch((err) =>
      console.error("[watchdog]", (err as Error).message),
    );
  }, WATCHDOG_INTERVAL_MS);

  // Tick loop. Each tick fans out across ALL (method, bucket) combinations.
  // Per-combo flow under methodology_version 2:
  //   1. derive challenge params via per-method handler.deriveChallenge
  //   2. fetch the auditor (utility) reference for the cross-check
  //   3. createReadyChallenge: write challenge + one assignment per vantage
  //   4. workers pick up the assignment, query all benchmarked providers,
  //      compute consensus locally in record.ts, and stamp correctness.
  // No more pre-flight quorum round → faster challenge dispatch.
  let tickInFlight = false;
  await refreshActiveVantages(db);
  if (_activeVantages.length === 0) {
    console.warn(
      "[generator] no live vantages on first refresh — first ticks will write no assignments until a worker heartbeats",
    );
  }
  setInterval(() => {
    if (tickInFlight) {
      console.warn("[generator] tick overlap — previous tick still running, skipping");
      return;
    }
    tickInFlight = true;
    const combos = allMethodBucketCombos();
    // Wrap the tick body in an async IIFE so back-pressure check + vantage
    // refresh + per-combo fan-out share one promise we can race against the
    // hard timeout.
    const work = (async () => {
      const claimable = await countClaimableUnclaimed(db).catch(() => 0);
      if (claimable > BACKPRESSURE_THRESHOLD) {
        console.warn(
          `[generator] back-pressure skip: ${claimable} still-claimable unclaimed above ${BACKPRESSURE_THRESHOLD} — workers behind, deferring dispatch`,
        );
        return;
      }
      try {
        await refreshActiveVantages(db);
      } catch (err) {
        console.error("[vantages-refresh]", err);
      }
      await Promise.allSettled(
        combos.map((c) =>
          tickCombo({ db, observer, utility, secret, method: c.method, bucket: c.bucket }),
        ),
      );
    })();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, TICK_TIMEOUT_MS);
    });
    Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        console.warn(
          `[generator] tick exceeded ${TICK_TIMEOUT_MS}ms — releasing scheduler lock; one or more in-flight promises may still complete in the background`,
        );
      }
      tickInFlight = false;
    });
  }, TICK_INTERVAL_MS);

  // Fast rollup — every 5 min, OWN interval + overlap guard. Folds samples →
  // rollups_5m, the live chart's source. Kept separate from the heavy rollups
  // below so a slow heavy tick can never skip this one: when both shared a
  // single guard, a slow rollup1h/1d/eligibility step dropped the next firing —
  // including rollup5m — and the chart's latest 5-min bucket lurched forward in
  // ~10-15 min bursts instead of advancing every 5 min.
  let rollup5mInFlight = false;
  const runFastRollup = (label: string) => {
    if (rollup5mInFlight) {
      console.warn("[rollup5m] previous tick still running, skipping this firing");
      return;
    }
    rollup5mInFlight = true;
    runRollup5m(db)
      .catch((err) => console.error(label, err))
      .finally(() => {
        rollup5mInFlight = false;
      });
  };
  setInterval(() => runFastRollup("[rollup5m]"), ROLLUP_INTERVAL_MS);
  // Run once at startup so the chart has a fresh 5m bucket immediately.
  runFastRollup("[rollup5m-startup]");

  // Heavy rollup — own 5-min interval + own overlap guard. Folds rollups_1h/1d,
  // prunes, and refreshes eligibility. Safe to overrun: it only defers itself,
  // never the fast rollup5m above (and writes disjoint targets from it).
  let heavyRollupInFlight = false;
  const runHeavyRollup = (label: string) => {
    if (heavyRollupInFlight) {
      console.warn("[rollup-heavy] previous tick still running, skipping this firing");
      return;
    }
    heavyRollupInFlight = true;
    runHeavyRollups(db)
      .catch((err) => console.error(label, err))
      .finally(() => {
        heavyRollupInFlight = false;
      });
  };
  setInterval(() => runHeavyRollup("[rollup-heavy]"), ROLLUP_INTERVAL_MS);
  // Run once at startup too so eligibility reflects existing data immediately.
  runHeavyRollup("[rollup-heavy-startup]");

  // Leaderboard precompute — own 5-min interval, own overlap guard. Decoupled
  // from the rollup tick so the heavy GROUPING SETS / win-ranking CTEs can run
  // long without starving rollup5m. Writes disjoint tables from the rollup
  // tick, so the two are safe to run concurrently.
  let lbInFlight = false;
  const runLeaderboard = (label: string) => {
    if (lbInFlight) {
      console.warn("[leaderboard-precompute] previous run still running, skipping this firing");
      return;
    }
    lbInFlight = true;
    runLeaderboardPrecompute(db)
      .catch((err) => console.error(label, err))
      .finally(() => {
        lbInFlight = false;
      });
  };
  setInterval(() => runLeaderboard("[leaderboard-precompute]"), ROLLUP_INTERVAL_MS);
  // Kick once at startup so the >24h leaderboard views populate immediately.
  runLeaderboard("[leaderboard-precompute-startup]");

  // Finality re-verification — independent every-2-min interval.
  // Each call audits up to FINALITY_RECHECK_BATCH (25) eligible challenges
  // via the auditor and writes to consensus_audit. Decoupled from the rollup
  // tick because the leaderboard CTE there can run >5 min and would otherwise
  // permanently block the audit job. Both jobs are safe to run concurrently
  // — they touch disjoint tables.
  const FINALITY_INTERVAL_MS = 2 * 60 * 1000;
  let finalityInFlight = false;
  const runFinality = () => {
    if (finalityInFlight) {
      console.warn("[finality-recheck] previous tick still running, skipping");
      return;
    }
    finalityInFlight = true;
    runFinalityRecheck(db, utility)
      .catch((err) => console.error("[finality-recheck]", (err as Error).message))
      .finally(() => {
        finalityInFlight = false;
      });
  };
  setInterval(runFinality, FINALITY_INTERVAL_MS);
  // Kick once at startup so the consensus-accuracy metric on the dashboard
  // populates without waiting two minutes.
  runFinality();

  // Use unref to allow shutdown signals; main process stays alive on intervals.
  await new Promise(() => {}); // run forever
}

main().catch((err) => {
  console.error("[generator] fatal", err);
  process.exit(1);
});

// Exports for tests / honeypot seed CLI.
export { tickCombo };
