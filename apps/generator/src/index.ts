import { sql } from "drizzle-orm";
import {
  METHODOLOGY_VERSION,
  UTILITY_PROVIDER,
  EMITTED_METHODS,
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
import { createDb, createReadyChallenge, stashSeed, executeRows, firstRow } from "@rpcbench/db";
import { createUtilityClient, type MultiEndpointRpcClient } from "./utility-client.js";
import { SlotObserver } from "./observe.js";
import { drawHoneypot, shouldInjectHoneypot } from "./honeypot.js";
import { commitmentHash, generateSeed } from "./commit-reveal.js";
import {
  acquireLeader,
  evictAndAcquireLeader,
  verifyLeadership,
  writeHeartbeat,
} from "./heartbeat.js";
import { ensurePartitions } from "./partitions.js";
import { runMaintenance } from "./maintenance.js";
import { runSendTick } from "./send/tick.js";
import { runConfirmPoll, heartbeatConfirm } from "./send/confirm.js";
import { runSendRollup5m, runSendHeavyRollups, runSendLeaderboard } from "./send-rollup.js";
import {
  KeyRegistry,
  loadMasterFromEnv,
  loadSendWallets,
  loadExistingPayers,
  sendTargetOf,
  runFundingTick,
  runHarvestTick,
  harvestBeatAgeMs,
  heartbeatHarvest,
  createSolanaRpc,
} from "@rpcbench/send";
import { SEND_TARGET_CONFIGS, VANTAGE_SAMPLE_SIZE, type Scenario } from "@rpcbench/shared";
import { ensureProvidersSeeded } from "./seed-providers.js";
import {
  ROLLUP_INTERVAL_MS,
  runHeavyRollups,
  runLeaderboardPrecompute,
  runRollup5m,
} from "./rollup.js";

/** Parse a lamports env var as bigint, falling back to `dflt` on empty/invalid. `BigInt`
 *  throws on a non-integer string (`"2_000_000"`, `"0.002"`) — at module scope that would
 *  crashloop the generator — and silently returns `0n` for `""`, which would (e.g.) make
 *  HARVEST_MIN_WSOL_LAMPORTS close every ATA every tick. Guard both. */
function bigintEnv(name: string, dflt: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  try {
    return BigInt(raw);
  } catch {
    console.warn(`[send] ${name}="${raw}" is not an integer; using default ${dflt}`);
    return dflt;
  }
}

const VANTAGE_FRESHNESS_S = 60;
const TICK_INTERVAL_MS = 30_000;
// Hard ceiling on a single tick so one hung promise (DB socket, utility RPC,
// etc.) can't pin tickInFlight=true and starve the scheduler forever. The
// slack vs TICK_INTERVAL_MS guarantees the lock is released before the next
// tick fires.
const TICK_TIMEOUT_MS = 25_000;

// Dispatch fan-out K=3 (VANTAGE_SAMPLE_SIZE) is defined in @rpcbench/shared
// (timing.ts, imported above) — shared so the send swap builders derive their
// reverse-swap safety divisor from the same value. Rationale + tradeoffs:
// docs/operations.md § K-sampling.

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
 * Per-(method,bucket) derivation-failure backoff.
 *
 * Some buckets structurally can't be filled from a random recent block (e.g.
 * getAccountInfo `mint`/`token_account`, getProgramAccounts `by_mint`): their
 * derivation scans up to ~120 candidate accounts one RPC each, finds nothing,
 * and returns null — then re-runs the entire ~120-call scan on the next tick,
 * forever. That scanning is the dominant load on the utility (chain-observation)
 * endpoint. See docs/methodology.md / the derivation handlers in
 * packages/methods.
 *
 * Backoff only kicks in after DERIVE_BACKOFF_GRACE *consecutive* failures, so a
 * bucket that fails intermittently (random-block variance — most buckets do) is
 * still attempted every tick and keeps its sample coverage; only a chronically
 * unfillable bucket (fails ~100%) crosses the grace threshold and then backs off
 * exponentially. This matters because batching already made a failed attempt
 * cheap (~3 calls), so there's no RPS reason to skip intermittent failers — the
 * ~120-call pathological scans are gone. Any success resets the streak.
 *
 * Gates ONLY the derivation call inside tickCombo — the honeypot injection path
 * still runs for every combo — so honeypot coverage is unaffected.
 *
 * Module-level (the generator process is long-lived; deriveChallenge gets a
 * fresh ChallengeContext each tick and can't hold cross-tick state).
 */
const DERIVE_BACKOFF_GRACE = 4; // consecutive failures tolerated before backing off
const DERIVE_BACKOFF_MAX_MULT = 30; // ×TICK_INTERVAL_MS ≈ 15 min ceiling
const _deriveBackoff = new Map<string, { failStreak: number; skipUntil: number }>();

function backoffKey(method: Method, bucket: string): string {
  return `${method}|${bucket}`;
}

/** True if this combo's derivation is currently in a backoff cooldown. */
function derivationOnCooldown(method: Method, bucket: string, now: number): boolean {
  const e = _deriveBackoff.get(backoffKey(method, bucket));
  return e !== undefined && e.skipUntil > now;
}

/**
 * Record a null (failed) derivation. Below the grace threshold we track the
 * streak but keep attempting every tick (no cooldown); past it we back off
 * exponentially so a chronically-unfillable bucket stops scanning.
 */
function recordDerivationFailure(method: Method, bucket: string, now: number): void {
  const key = backoffKey(method, bucket);
  const failStreak = (_deriveBackoff.get(key)?.failStreak ?? 0) + 1;
  if (failStreak < DERIVE_BACKOFF_GRACE) {
    _deriveBackoff.set(key, { failStreak, skipUntil: 0 });
    return;
  }
  const mult = Math.min(2 ** (failStreak - DERIVE_BACKOFF_GRACE + 1), DERIVE_BACKOFF_MAX_MULT);
  _deriveBackoff.set(key, { failStreak, skipUntil: now + mult * TICK_INTERVAL_MS });
}

/** Record a successful derivation: clear any backoff for this combo. */
function recordDerivationSuccess(method: Method, bucket: string): void {
  _deriveBackoff.delete(backoffKey(method, bucket));
}

/**
 * Heartbeat-driven vantage registry. The set of (worker_provider, region,
 * egress_path) triples we fan challenges out to is whatever has heartbeated
 * in the last VANTAGE_FRESHNESS_S seconds — no hardcoded list. New vantages
 * bootstrap by deploying their worker; old ones drop out when they stop
 * heartbeating.
 *
 * Cached for the duration of a tick (refreshed at the start of each tick
 * loop iteration) so all per-combo fanouts in one tick agree on the same
 * vantage set.
 */
let _activeVantages: Array<{ worker_provider: string; region: string; egress_path: string }> = [];

async function refreshActiveVantages(db: ReturnType<typeof createDb>): Promise<void> {
  const rows = await executeRows<{ worker_provider: string; region: string; egress_path: string }>(
    db,
    sql`
    SELECT DISTINCT worker_provider, region, egress_path
    FROM worker_heartbeat
    WHERE beat_at > now() - (${VANTAGE_FRESHNESS_S}::int || ' seconds')::interval
  `,
  );
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
// Storage-bounding maintenance (reference_response trim + control-table prune).
// Every 5 min is plenty: only ~375 challenges cross the 6h frontier per such
// interval at steady state. See apps/generator/src/maintenance.ts.
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

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
  const r = await firstRow<{ n: number }>(
    db,
    sql`
    SELECT count(*)::int AS n
    FROM challenge_assignments ca
    JOIN challenges c ON c.id = ca.challenge_id
    WHERE ca.status = 'unclaimed'
      AND c.expires_at > now()
  `,
  );
  return r?.n ?? 0;
}

/**
 * Flip past-TTL unclaimed assignments to `expired`. Without this, workers
 * waste claim cycles on dead rows (claim → see expired → markDone → repeat),
 * and the back-pressure check can be fooled by a huge zombie backlog into
 * never dispatching. Runs every minute alongside `expireStaleChallenges`.
 */
// Batched like revealExpiredSeeds: the unindexed unbounded UPDATE locked every
// matched row for its whole duration, so under load one run outran the 60s tick
// and the next overlapped on the same rows (the assignment flavor of the
// seed-reveal convoy). Each batch LIMITs the lock footprint + statement time and
// FOR UPDATE OF ca SKIP LOCKED so overlapping runs take disjoint rows instead of
// blocking. `FOR UPDATE OF ca` locks only assignment rows, not the joined
// `challenges`, so it never contends with dispatch / seed-reveal. Backed by
// challenge_assignments_unclaimed_idx (0001_initial.sql). ctid is stable within
// the locked statement (same pattern as the maintenance trims).
const EXPIRE_ASSIGN_BATCH = 5_000;
const EXPIRE_ASSIGN_MAX_BATCHES = 50;
async function expireStaleAssignments(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  for (let i = 0; i < EXPIRE_ASSIGN_MAX_BATCHES; i++) {
    const expired = await db.execute(sql`
      WITH due AS (
        SELECT ca.ctid
        FROM challenge_assignments ca
        JOIN challenges c ON c.id = ca.challenge_id
        WHERE ca.status = 'unclaimed'
          AND c.expires_at < now() - interval '30 seconds'
        LIMIT ${EXPIRE_ASSIGN_BATCH}
        FOR UPDATE OF ca SKIP LOCKED
      )
      UPDATE challenge_assignments ca
      SET status = 'expired'
      FROM due
      WHERE ca.ctid = due.ctid
      RETURNING 1
    `);
    if ((expired as unknown as unknown[]).length < EXPIRE_ASSIGN_BATCH) break;
  }
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
  // Reads the denormalized `has_samples` flag (set by insertSamples) instead of
  // a NOT EXISTS scan over the ~40M-row `samples` table. Index-backed by
  // challenges_expiry_candidates_idx (0001_initial.sql). REQUIRES that the flag is
  // populated first — deploy order is migrate → workers (flag new) → backfill
  // (flag existing) → THIS generator. Running it before the backfill would
  // mislabel sampled-but-unflagged challenges as expired (cosmetic, recoverable).
  await db.execute(sql`
    UPDATE challenges
    SET status = 'expired'
    WHERE status = 'ready'
      AND expires_at < now() - interval '30 seconds'
      AND has_samples = false
  `);
}

function utilityClient(): MultiEndpointRpcClient {
  if (!UTILITY_PROVIDER) throw new Error("UTILITY_PROVIDER missing");
  // Resolve the configured endpoint(s), skipping any whose env var is unset.
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
      "Utility provider has no resolvable endpoints — set UTILITY_RPC_URL at minimum",
    );
  }
  console.log(
    `[utility-client] ${specs.length} endpoint(s): ${specs.map((s) => s.env_var).join(", ")}`,
  );
  return createUtilityClient(specs, 5000);
}

function allMethodBucketCombos(): Array<{ method: Method; bucket: string }> {
  // Emitted methods (and their dormant counterparts) are defined in
  // @rpcbench/shared so the generator and benchmark CLI can't drift.
  const out: Array<{ method: Method; bucket: string }> = [];
  for (const m of EMITTED_METHODS) {
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

  // Derive a fresh challenge — unless this combo is in a failure backoff. The
  // cooldown gates only this derivation scan (the honeypot path above already
  // ran), so chronically-unfillable buckets stop hammering the utility endpoint
  // with ~120-call scans every tick.
  if (derivationOnCooldown(method, bucket, Date.now())) {
    return;
  }
  const handler = HANDLERS[method];
  const derived = await handler.deriveChallenge({
    recentSlots: opts.observer.recentSlots(),
    utility: opts.utility,
    method,
    bucket,
  });
  if (!derived) {
    recordDerivationFailure(method, bucket, Date.now());
    return; // bucket couldn't be filled this tick; backed off for next.
  }
  recordDerivationSuccess(method, bucket);

  const seed = generateSeed(opts.secret, opts.observer.tipSlot(), Date.now());
  const params = paramsAsArray(method, derived.params);
  const cHash = commitmentHash(seed, params);

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
    // Normal challenges carry no reference answer (correctness is decided by
    // panel consensus). We still record the generator's tip slot so samples get
    // freshness_lag / the stale check.
    {
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

// Batched so this can never become an unbounded UPDATE. An UPDATE over the
// whole pending set locks every matched row for its entire runtime and
// maintains every index on `challenges`; once that exceeds
// SEED_REVEAL_INTERVAL_MS the next tick overlaps and the two convoy on the same
// rows, so the backlog never drains (this is the seed-reveal flavor of the
// generator-saturation incident in docs/operations.md). Each batch instead:
//   - LIMITs the lock footprint + statement time to a small, bounded slice;
//   - FOR UPDATE SKIP LOCKED so even if two runs overlap they take disjoint
//     rows instead of blocking — convoy is structurally impossible;
//   - no ORDER BY: reveal order is irrelevant, and dropping it lets the scan
//     stop at LIMIT rows instead of top-N sorting the whole pending set.
// MAX_BATCHES bounds work per tick; any remainder drains on the next tick.
const SEED_REVEAL_BATCH = 5_000;
const SEED_REVEAL_MAX_BATCHES = 50;
async function revealExpiredSeeds(db: ReturnType<typeof createDb>): Promise<void> {
  for (let i = 0; i < SEED_REVEAL_MAX_BATCHES; i++) {
    const revealed = await db.execute(sql`
      WITH due AS (
        SELECT id FROM challenges
        WHERE seed_revealed_at IS NULL
          AND expires_at < now()
          AND seed IS NOT NULL
        LIMIT ${SEED_REVEAL_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE challenges c
      SET seed_revealed_at = now()
      FROM due
      WHERE c.id = due.id
      RETURNING 1
    `);
    if ((revealed as unknown as unknown[]).length < SEED_REVEAL_BATCH) break;
  }
}

async function main() {
  const secret = process.env.GENERATOR_SECRET;
  if (!secret) throw new Error("GENERATOR_SECRET not set");

  // Two clients, deliberately split (see docs/operations.md § generator
  // saturation):
  //   - lockDb (direct, session-pinned): leader election only. The advisory
  //     lock is session-scoped, so it MUST live on a direct connection — it's
  //     unreliable through Neon's transaction-mode pooler. Tiny, low-frequency
  //     load (acquire + heartbeat), so it never contends.
  //   - db (pooled, max 20): everything else — the per-tick challenge inserts
  //     (~46 combos in parallel) plus the rollup/leaderboard CTEs and the cron
  //     jobs. On a small direct-connection pool these starve the tick (CPU
  //     idle, ticks > 25s) even though no query is individually slow. The
  //     pooler multiplexes, so 20 client slots clear the fan-out without
  //     connection-acquisition waits.
  // max:1 pins the advisory lock, heartbeat, and leadership check to one
  // persistent session, so pg_backend_pid() reliably identifies the lock holder
  // (see the lock-loss self-exit below and verifyLeadership).
  const lockDb = createDb({ mode: "direct", max: 1 });
  const db = createDb({ mode: "pooled" });

  // Surface an empty honeypot pool loudly: with zero honeypots the injection
  // path never fires and the eligibility gate's honeypot bound passes
  // vacuously (wilson_lower_bound over 0 trials is 1.0), so the anti-gaming
  // defense is silently inactive and nothing else would tell the operator.
  try {
    const pool = await firstRow<{ n: string }>(db, sql`SELECT count(*)::text AS n FROM honeypot_pool`);
    if (!pool || pool.n === "0") {
      console.warn(
        "[generator] honeypot_pool is EMPTY — honeypot injection is inactive and the eligibility gate's honeypot bound passes vacuously. Seed it per method: `pnpm --filter generator seed-honeypots --method getBlock --count 100` (see README § Seed the honeypot pool).",
      );
    }
  } catch (err) {
    console.warn("[generator] honeypot_pool startup check failed", err);
  }

  // Graceful shutdown — release the advisory lock instantly instead of
  // waiting for Neon's idle-session timeout. Runs on lockDb (the session that
  // holds the lock).
  const shutdown = async (signal: string) => {
    console.log(`[generator] ${signal} received, shutting down`);
    try {
      await lockDb.execute(sql.raw("SELECT pg_advisory_unlock_all()"));
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  let isLeader = await acquireLeader(lockDb);
  while (!isLeader) {
    console.log("[generator] not leader, waiting for stale heartbeat...");
    await new Promise((r) => setTimeout(r, 15_000));
    isLeader = await evictAndAcquireLeader(lockDb);
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

  // Heartbeat + leader-lock self-check on lockDb. Both run on the pinned
  // (max:1) lock session every HEARTBEAT_INTERVAL_MS.
  //
  // Why the self-check exists: a standby evicts a stale leader with
  // pg_terminate_backend (heartbeat.ts), which kills our lock SESSION but not
  // this process — postgres-js silently reconnects and every setInterval job
  // keeps running on a session that no longer holds the lock (split-brain).
  // Nothing else catches it: the liveness watchdog only fires on ZERO challenges,
  // and a split-brained rogue is still producing. So we verify ownership here and
  // exit so ECS restarts us as a clean standby.
  //
  // Three cases, deliberately handled differently:
  //   - held === false  → definitive: another instance holds the lock. Exit.
  //   - thrown error     → ambiguous (transient blip / full DB outage). Ride it
  //                        out — a full outage means no standby can acquire
  //                        either, so there's no split-brain; exiting here would
  //                        crashloop through DB-side incidents.
  //   - HANG (never returns/throws) → lockDb half-open while the pooled `db`
  //                        stays healthy: challenges keep flowing (liveness
  //                        watchdog green) but a standby will evict us at 30s. The
  //                        in-memory hang detector below (a pure Date.now() check,
  //                        immune to the stuck query) exits us first.
  const LEADER_HANG_MS = 20_000; // < the standby's 30s stale-heartbeat eviction
  let leaderCheckInFlight = false;
  let leaderCheckStartedAt = 0;
  setInterval(() => {
    // Hang detection first — synchronous, so it fires even while a prior check
    // is stuck on a wedged connection.
    if (leaderCheckInFlight) {
      if (Date.now() - leaderCheckStartedAt > LEADER_HANG_MS) {
        console.error(
          `[generator] leader-lock check hung >${LEADER_HANG_MS / 1000}s (lockDb wedged) — exiting so ECS restarts`,
        );
        process.exit(1);
      }
      return; // prior check still running but not yet hung
    }
    leaderCheckInFlight = true;
    leaderCheckStartedAt = Date.now();
    (async () => {
      await writeHeartbeat(lockDb);
      const held = await verifyLeadership(lockDb);
      if (!held) {
        console.error(
          "[generator] lost the leader advisory lock (another instance holds it) — exiting so ECS restarts as standby",
        );
        process.exit(1);
      }
    })()
      .catch((err) => {
        // Thrown, not held=false → ride it out (see case notes above).
        console.error("[generator] heartbeat/leader-check failed, riding out:", (err as Error).message);
      })
      .finally(() => {
        leaderCheckInFlight = false;
      });
  }, HEARTBEAT_INTERVAL_MS);

  // In-flight guard: a bare setInterval fires again at the next tick even if
  // the previous reveal is still draining a backlog, stacking overlapping runs.
  // Skip the tick if one is still going (same pattern as the other jobs).
  let revealInFlight = false;
  setInterval(() => {
    if (revealInFlight) return;
    revealInFlight = true;
    revealExpiredSeeds(db)
      .catch(() => {}) // best-effort: unrevealed seeds are picked up next tick
      .finally(() => {
        revealInFlight = false;
      });
  }, SEED_REVEAL_INTERVAL_MS);

  // Flip stale ready→expired AND unclaimed→expired every minute. Without
  // these, K-sampling combined with the existing zombie backlog leaves
  // "ready" challenges + "unclaimed" assignments sitting around forever,
  // confusing the dashboard's recent-challenges view AND freezing dispatch
  // (back-pressure can be fooled into never dispatching by a huge zombie
  // queue).
  // In-flight guard (same as revealExpiredSeeds above): under load an expiry
  // run can exceed the 60s interval, and a bare setInterval would fire the next
  // run on top of it — overlapping runs then convoy on the same rows. Skip the
  // tick if one is still going.
  let expireInFlight = false;
  const runExpiry = () => {
    if (expireInFlight) return;
    expireInFlight = true;
    Promise.allSettled([
      // Now reads the cheap `has_samples` flag (0001_initial.sql) instead of
      // scanning `samples` — safe to run every minute. See expireStaleChallenges.
      expireStaleChallenges(db),
      expireStaleAssignments(db),
    ])
      .then((results) => {
        for (const r of results) {
          if (r.status === "rejected") {
            console.error("[expire-stale]", (r.reason as Error).message);
          }
        }
      })
      .finally(() => {
        expireInFlight = false;
      });
  };
  setInterval(runExpiry, EXPIRE_STALE_INTERVAL_MS);
  // Run once at startup so the existing backlog clears before the first
  // dispatch tick — otherwise the new generator's first tick sees a zombie
  // queue from before the deploy and back-pressure-skips forever.
  runExpiry();

  // Publish the utility-RPC client's per-endpoint health to the
  // `utility_rpc_status` table every 10s. The dashboard reads from there to
  // render the utility-endpoint health row so an upstream provider going dark
  // surfaces as a red dot immediately instead of a silent outage.
  const publishUtilityStatus = async () => {
    const snapshot = utility.getStatus();
    for (const s of snapshot) {
      await db.execute(sql`
        INSERT INTO utility_rpc_status (
          endpoint_index, url_label, last_ok_at, last_err_at, last_err_msg,
          consec_fails, circuit_state, updated_at
        )
        VALUES (
          ${s.endpoint_index}, ${s.url_label},
          ${s.last_ok_at ? s.last_ok_at.toISOString() : null},
          ${s.last_err_at ? s.last_err_at.toISOString() : null},
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

  // Liveness watchdog. A fresh heartbeat row + healthy ECS task can coexist
  // with silently-stalled challenge insertion, so treat "challenges flowing"
  // as the real liveness signal; if it stops for too long while we're leader,
  // exit so ECS replaces the task and alerts can fire on the restart.
  const WATCHDOG_INTERVAL_MS = 60_000;
  const WATCHDOG_STALE_THRESHOLD_MS = 5 * 60_000;
  setInterval(() => {
    (async () => {
      const r = await firstRow<{ n: number }>(
        db,
        sql`
        SELECT count(*)::int AS n
        FROM challenges
        WHERE generated_at > now() - make_interval(secs => ${WATCHDOG_STALE_THRESHOLD_MS / 1000})
      `,
      );
      const n = r?.n ?? 0;
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

  // Storage & write-path watchdog. The challenge watchdog above only detects a
  // stalled GENERATOR — it stays green when challenges flow but SAMPLES are
  // wedged, which is exactly how the 2026-07-01 lock-convoy outage ran ~18h
  // undetected. These checks target that blind spot. They only LOG (loudly, at
  // ERROR): a samples/lock/size problem is a DB-side condition the generator
  // cannot fix by restarting, so we surface it for alerting rather than exit.
  const STORAGE_WATCHDOG_INTERVAL_MS = 2 * 60_000;
  const SAMPLES_STALE_SECS = 180;
  const LONG_TXN_SECS = 300;
  // NOTE ON REACH: everything below only WRITES TO THE LOG. There is no
  // CloudWatch MetricFilter on "[storage-watchdog]" and no SNS subscriber —
  // infra/cdk/lib/alerts-stack.ts carries HighCpu and TaskShortfall only. So
  // these are signals for someone already reading logs, NOT pages. Do not
  // describe them as alarms; if paging is ever wanted, add a MetricFilter onto
  // the existing SNS topic (~10 lines) and say so here.
  //
  // Thresholds recalibrated 2026-08-31 against a MEASURED steady state (the old
  // 150 GB was chosen only as "well under the prior 1.24 TB blowup"). WARN is
  // "look at this soon"; ERROR is "something is structurally wrong".
  const DB_SIZE_WARN_BYTES = 80 * 1024 ** 3;
  const DB_SIZE_ERROR_BYTES = 150 * 1024 ** 3;
  // The RATE signal, and the most useful one here. A cumulative-total threshold
  // is a LAGGING indicator whenever retention is longer than a day: the
  // 2026-08-31 incident sat at a 30-day equilibrium, so the database was not
  // "growing" at all by the time it was 2.18 TB — the config that doomed it had
  // looked correct for a month. Today's partition size is the LEADING indicator:
  // it goes wrong within hours of a bad write rule shipping.
  //
  // Sizing, measured on prod immediately after the 2026-08-31 deploy: today's
  // partition grew at 3.25 GB/day (heap ~1.5 + indexes ~1.0 + toast ~0.1), so
  // 8 GB is ~2.5x. Two adjustments to keep in mind before changing it:
  //   * Dropping samples_lookup_idx / samples_dash_idx takes ~0.9 GB/day off,
  //     making the ratio ~3.5x. Fine — the threshold does not need lowering.
  //   * keepRaw retains honeypot rows where correctness <> 'correct', which
  //     includes `ambiguous` (no_consensus / operational_error), not just real
  //     misses. Under a fleet-wide provider outage nearly every honeypot can go
  //     ambiguous: ~19k rows/day x the 32 KiB cap is ~0.6 GB/day on top. That is
  //     the cap doing its job — bounded, ~4 GB/day worst case, still ~2x under
  //     this threshold — but it is why the budget is not set tighter than 8 GB.
  const PARTITION_DAY_WARN_BYTES = 8 * 1024 ** 3;
  setInterval(() => {
    (async () => {
      const s = await firstRow<{
        samples_recent: number;
        long_txn_secs: number;
        lock_waiters: number;
        db_bytes: number;
        today_partition_bytes: number;
        today_partition_name: string;
        top_relations: string | null;
      }>(
        db,
        sql`
        SELECT
          (SELECT count(*)::int FROM samples
             WHERE started_at > now() - make_interval(secs => ${SAMPLES_STALE_SECS})) AS samples_recent,
          (SELECT COALESCE(EXTRACT(EPOCH FROM max(now() - xact_start)), 0)::int
             FROM pg_stat_activity
             WHERE datname = current_database() AND state <> 'idle' AND xact_start IS NOT NULL) AS long_txn_secs,
          (SELECT count(*)::int FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock') AS lock_waiters,
          pg_database_size(current_database())::bigint AS db_bytes,
          -- Today's samples partition: the leading indicator (see the constants above).
          -- COALESCE wraps the SUBQUERY, not the inner expression: a missing
          -- partition makes the subquery return NO ROW (so NULL), and NULL fails
          -- every greater-than comparison silently — which would no-op this check in
          -- exactly the case where partition creation had failed.
          COALESCE((SELECT pg_total_relation_size(c.oid)::bigint
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relname = 'samples_' || to_char(current_date, 'YYYYMMDD')), 0) AS today_partition_bytes,
          -- Return the partition NAME from SQL too. The diagnostic query pasted
          -- into the log below must reference the same partition this row
          -- measured; deriving it in JS from new Date() only agrees while the DB
          -- timezone is UTC.
          'samples_' || to_char(current_date, 'YYYYMMDD') AS today_partition_name,
          -- Name the culprit. The 2026-08-31 alert said only "database size
          -- 2183.6 GB exceeds 150 GB", which told nobody WHICH table or column,
          -- so diagnosis took a full session of manual pg_class spelunking. Emit
          -- the top consumers (with their TOAST share, since TOAST was 98% of the
          -- problem and is invisible in a plain table-size listing) so the next
          -- alert diagnoses itself.
          (SELECT string_agg(x.line, ', ' ORDER BY x.total DESC)
             FROM (
               SELECT c.relname
                        || ' ' || pg_size_pretty(pg_total_relation_size(c.oid))
                        || CASE WHEN c.reltoastrelid <> 0
                                  AND pg_total_relation_size(c.reltoastrelid) > 0
                                THEN ' (toast ' || pg_size_pretty(pg_total_relation_size(c.reltoastrelid)) || ')'
                                ELSE '' END AS line,
                      pg_total_relation_size(c.oid) AS total
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
               ORDER BY pg_total_relation_size(c.oid) DESC
               LIMIT 3
             ) x) AS top_relations
      `,
      );
      if (!s) return;
      if (s.samples_recent === 0) {
        console.error(
          `[storage-watchdog] NO SAMPLES written in the last ${SAMPLES_STALE_SECS}s while the generator is live — ` +
            `likely a sample-insert wedge / lock convoy (the 2026-07-01 failure mode). Inspect pg_stat_activity for Neon/RelExists waits.`,
        );
      }
      if (s.long_txn_secs > LONG_TXN_SECS || s.lock_waiters > 0) {
        console.error(
          `[storage-watchdog] lock/txn pressure: oldest active txn ${s.long_txn_secs}s, ` +
            `${s.lock_waiters} session(s) waiting on locks — possible convoy forming.`,
        );
      }
      const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
      // Rate check first: it fires earlier and is the more actionable signal.
      if (s.today_partition_bytes > PARTITION_DAY_WARN_BYTES) {
        console.error(
          `[storage-watchdog] TODAY's samples partition is ${gb(s.today_partition_bytes)}, over the ` +
            `${gb(PARTITION_DAY_WARN_BYTES)} daily budget — a write rule is retaining more BYTES per row than expected ` +
            `(check raw_response: \`SELECT method, is_honeypot, count(*), pg_size_pretty(sum(pg_column_size(raw_response))) ` +
            `FROM ${s.today_partition_name} GROUP BY 1,2 ORDER BY 4 DESC\`). ` +
            `Do NOT wait for the total-size check: with multi-day retention it lags by the full retention window. ` +
            `Top relations: ${s.top_relations ?? "n/a"}`,
        );
      }
      if (s.db_bytes > DB_SIZE_ERROR_BYTES) {
        console.error(
          `[storage-watchdog] database size ${gb(s.db_bytes)} exceeds the ${gb(DB_SIZE_ERROR_BYTES)} ERROR line — ` +
            `retention or a per-row byte budget is broken. Top relations: ${s.top_relations ?? "n/a"}`,
        );
      } else if (s.db_bytes > DB_SIZE_WARN_BYTES) {
        console.warn(
          `[storage-watchdog] database size ${gb(s.db_bytes)} exceeds ${gb(DB_SIZE_WARN_BYTES)} — ` +
            `check retention/reclaim before it degrades recovery. Top relations: ${s.top_relations ?? "n/a"}`,
        );
      }
    })().catch((err) => console.error("[storage-watchdog]", (err as Error).message));
  }, STORAGE_WATCHDOG_INTERVAL_MS);

  // Tick loop. Each tick fans out across ALL (method, bucket) combinations.
  // Per-combo flow:
  //   1. derive challenge params via per-method handler.deriveChallenge
  //   2. createReadyChallenge: write challenge + one assignment per vantage
  //   3. workers pick up the assignment, query all benchmarked providers,
  //      compute consensus locally in record.ts, and stamp correctness.
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
  // below so a slow heavy tick can never skip this one: sharing a single guard
  // would let a slow rollup1h/1d/eligibility step drop the next firing —
  // including rollup5m — making the chart's latest 5-min bucket advance in
  // bursts instead of every 5 min.
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

  // Heavy rollup — own 5-min interval + own overlap guard. Folds rollups grain='1h'/'1d',
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

  // Storage-bounding maintenance — own interval + overlap guard, decoupled from
  // the rollup tick (its long CTE would otherwise starve this). Trims old
  // reference_response payloads and caps the control-plane tables at 31d. The
  // first post-deploy run drains any reference_response backlog over several
  // ticks (MAX_BATCHES_PER_RUN per firing). Run at startup too.
  let maintenanceInFlight = false;
  const runMaintenanceJob = () => {
    if (maintenanceInFlight) {
      console.warn("[maintenance] previous run still running, skipping this firing");
      return;
    }
    maintenanceInFlight = true;
    runMaintenance(db)
      .catch((err) => console.error("[maintenance]", (err as Error).message))
      .finally(() => {
        maintenanceInFlight = false;
      });
  };
  setInterval(runMaintenanceJob, MAINTENANCE_INTERVAL_MS);
  runMaintenanceJob();

  // ────────────────────────────────────────────────────────────
  // Send archetype (the /sends board). Gated by SENDS_ENABLED so it spends no
  // SOL and emits no send challenges when off. Runs on its OWN intervals —
  // never chained onto the read rollup tail (CLAUDE.md).
  // ────────────────────────────────────────────────────────────
  if (process.env.SENDS_ENABLED === "true") {
    const sendScenarios = (process.env.SEND_SCENARIOS ?? "transfer")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as Scenario[];
    // Send tick is DECOUPLED from the 30s read cadence: every send pays real
    // relay tips, so frequency drives SOL burn. Default 5min (was 30s); tune via
    // SEND_TICK_INTERVAL_MS. (Observatory reference: 1800s.)
    // Guard against a non-numeric/empty env ("5m" → NaN, "" → 0 → both would floor to the
    // minimum cadence, not the intended default). Require a finite positive number.
    const sendTickRaw = Number(process.env.SEND_TICK_INTERVAL_MS);
    const sendTickMs = Math.max(30_000, Number.isFinite(sendTickRaw) && sendTickRaw > 0 ? sendTickRaw : 300_000);
    // The funding floor — read by funding (top-up threshold) AND harvest (asserts its
    // sweep float stays ≥ this so a swept wallet never re-enters the top-up band).
    const sendMinBalanceLamports = bigintEnv("SEND_MIN_BALANCE_LAMPORTS", 10_000_000n);
    console.log(`[send] enabled; scenarios=${sendScenarios.join(",")} tick=${sendTickMs}ms`);

    // Wallet funding (leader-only). Creates + tops up per-(target × scenario)
    // wallets from SEND_MASTER_KEYPAIR; records balances for the low-balance
    // alert. Best-effort; never crashes the generator.
    let fundingInFlight = false;
    const runFunding = async (): Promise<void> => {
      if (fundingInFlight) return;
      fundingInFlight = true;
      try {
        const master = await loadMasterFromEnv();
        const rpc = createSolanaRpc(
          process.env.SEND_FUNDING_RPC_URL ?? process.env.UTILITY_RPC_URL ?? "",
        );
        const registry = new KeyRegistry(db);
        const wallets = await loadSendWallets(registry, sendScenarios);
        await runFundingTick(db, rpc, master, wallets, {
          minBalanceLamports: sendMinBalanceLamports,
          topupLamports: bigintEnv("SEND_TOPUP_LAMPORTS", 20_000_000n),
          region: process.env.WORKER_REGION ?? "generator",
        });
      } catch (err) {
        console.error("[send/funding]", (err as Error).message);
      } finally {
        fundingInFlight = false;
      }
    };
    setInterval(() => void runFunding(), 300_000);
    void runFunding();

    // Wallet harvest (leader-only). Loads the EXISTING payer wallets from the DB and
    // unwraps accumulated WSOL → native for still-configured targets (in place — stops the
    // master burn by cutting funding top-ups); drains wallets of retired targets to the
    // master. NOT gated by SEND_SCENARIOS (that only gates what we SEND — a scenario
    // disabled this deploy still holds WSOL to reclaim), so it processes every payer row,
    // not just this deploy's active send set. Best-effort; every on-chain step is
    // confirmation-gated. See docs/operations.md § Harvest / SOL recovery.
    if ((process.env.HARVEST_ENABLED ?? "true") === "true") {
      // Guard against a non-numeric/empty env (NaN → setInterval ~1ms → runaway harvest;
      // "" → 0 → floors to 5min not the 1h default). Require a finite positive number.
      const harvestRaw = Number(process.env.HARVEST_INTERVAL_MS);
      const harvestMs = Math.max(300_000, Number.isFinite(harvestRaw) && harvestRaw > 0 ? harvestRaw : 3_600_000);
      // Thresholds parsed once. `rosterTargets` is the still-configured send targets.
      const minWsol = bigintEnv("HARVEST_MIN_WSOL_LAMPORTS", 2_000_000n);
      const activeFloor = bigintEnv("HARVEST_ACTIVE_FLOOR_LAMPORTS", 30_000_000n);
      const sweepCeiling = bigintEnv("HARVEST_SWEEP_CEILING_LAMPORTS", 50_000_000n);
      const rosterTargets = new Set<string>(SEND_TARGET_CONFIGS.map((c) => c.name));

      if (activeFloor < sendMinBalanceLamports || sweepCeiling <= activeFloor) {
        // The churn-free design relies on floor ≥ funding min (a swept wallet must not land
        // back in the top-up band) and ceiling > floor. Independent env vars, so assert it.
        // Write an unhealthy heartbeat so the ops verify query distinguishes misconfig from
        // a stuck tick (stale beat_at) rather than seeing no row at all.
        console.warn(
          `[send/harvest] invalid thresholds (floor=${activeFloor} min=${sendMinBalanceLamports} ceiling=${sweepCeiling}); ` +
            "need floor≥min and ceiling>floor — harvest disabled",
        );
        void heartbeatHarvest(db, false).catch((e) =>
          console.warn("[send/harvest] heartbeat write failed:", (e as Error).message),
        );
      } else if (rosterTargets.size === 0) {
        // Static array from the provider registry — only empty via a providers.ts edit that
        // removes every send target, which would otherwise orphan-drain the whole fleet.
        console.warn("[send/harvest] SEND_TARGET_CONFIGS is empty; harvest disabled (would orphan-drain the fleet)");
        void heartbeatHarvest(db, false).catch((e) =>
          console.warn("[send/harvest] heartbeat write failed:", (e as Error).message),
        );
      } else {
        let harvestInFlight = false;
        const runHarvest = async (): Promise<void> => {
          if (harvestInFlight) return;
          harvestInFlight = true;
          try {
            const master = await loadMasterFromEnv();
            const rpc = createSolanaRpc(
              process.env.SEND_FUNDING_RPC_URL ?? process.env.UTILITY_RPC_URL ?? "",
            );
            // Load EXISTING payer wallets only (never create — a harvest tick must not mint
            // fresh keypairs). Classify by the persisted send_target column (name-prefix
            // fallback only if null): still-configured targets are roster (unwrap in place);
            // retired targets are orphans (drained). NOT gated by SEND_SCENARIOS — a scenario
            // disabled this deploy still holds WSOL to reclaim.
            const payers = await loadExistingPayers(db);
            const rosterWallets = payers.filter((w) => rosterTargets.has(sendTargetOf(w)));
            const orphanWallets = payers.filter((w) => !rosterTargets.has(sendTargetOf(w)));
            await runHarvestTick(db, rpc, rosterWallets, orphanWallets, master, {
              region: process.env.WORKER_REGION ?? "generator",
              minWsolLamports: minWsol,
              activeFloorLamports: activeFloor,
              sweepCeilingLamports: sweepCeiling,
            });
          } catch (err) {
            console.error("[send/harvest]", (err as Error).message);
          } finally {
            harvestInFlight = false;
          }
        };
        setInterval(() => void runHarvest(), harvestMs);
        // Don't re-run a full harvest (real on-chain closes cost fees) on every boot — this
        // generator has a restart-loop history. Kick at startup only if we're overdue: the
        // last 'harvest' heartbeat is older than one interval, or none was ever recorded.
        void (async () => {
          const beatAge = await harvestBeatAgeMs(db);
          if (beatAge === null || beatAge >= harvestMs) {
            void runHarvest();
          } else {
            console.log(
              `[send/harvest] last tick ${Math.round(beatAge / 1000)}s ago (< interval); deferring to setInterval`,
            );
          }
        })();
      }
    } else {
      // Rollback lever (HARVEST_ENABLED=false): record disabled so the ops verify query
      // doesn't read the last (possibly ready=true) row + stale beat_at as a stuck tick.
      void heartbeatHarvest(db, false).catch((e) =>
        console.warn("[send/harvest] heartbeat write failed:", (e as Error).message),
      );
    }

    // Send challenge tick — one challenge per scenario, K-sampled to vantages.
    setInterval(() => {
      runSendTick({
        db,
        utility,
        sampleVantages: () => sampleK(_activeVantages, VANTAGE_SAMPLE_SIZE),
        scenarios: sendScenarios,
      }).catch((err) => console.error("[send/tick]", (err as Error).message));
    }, sendTickMs);

    // Confirmation — folded in from the former apps/confirm service. Own guarded
    // interval; reuses `db` + `utility`. Heartbeats send_service_status('confirm')
    // so the worker send lane's readiness gate is satisfied by this generator.
    let confirmInFlight = false;
    const confirmPollMs = Math.max(1_000, Number(process.env.CONFIRM_POLL_MS ?? 2_000));
    console.log(`[send] confirm poll every ${confirmPollMs}ms`);
    setInterval(() => {
      if (confirmInFlight) return; // in-flight guard: never stack polls
      confirmInFlight = true;
      runConfirmPoll(db, utility)
        .catch((err) => {
          console.error("[send/confirm]", (err as Error).message);
          // Stop heartbeating ready on error so the worker gate closes.
          void heartbeatConfirm(db, false).catch(() => {});
        })
        .finally(() => {
          confirmInFlight = false;
        });
    }, confirmPollMs);

    // Send rollups — separate intervals (never chained onto the read tail).
    setInterval(() => {
      runSendRollup5m(db).catch((err) => console.error("[send/rollup5m]", (err as Error).message));
    }, ROLLUP_INTERVAL_MS);
    setInterval(() => {
      runSendHeavyRollups(db)
        .then(() => runSendLeaderboard(db))
        .catch((err) => console.error("[send/rollup-heavy]", (err as Error).message));
    }, ROLLUP_INTERVAL_MS);
  } else {
    console.log("[send] disabled (set SENDS_ENABLED=true to enable)");
  }

  // Park forever; the setInterval timers above keep the process alive, and the
  // SIGTERM/SIGINT handlers drive shutdown.
  await new Promise(() => {}); // run forever
}

main().catch((err) => {
  console.error("[generator] fatal", err);
  process.exit(1);
});

// Exports for tests / honeypot seed CLI.
export { tickCombo };
