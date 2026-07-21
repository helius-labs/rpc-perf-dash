/**
 * Verification for the wedge guards (run: `pnpm --filter worker exec tsx src/watchdog.verify.mts`).
 * Proves the two guarantees the prod wedge violated:
 *   1. a hung iteration no longer freezes the loop — it rejects on a budget.
 *   2. a sustained failure streak self-heals, while healthy/idle never does.
 */
import assert from "node:assert/strict";
import { withTimeout, shouldSelfHeal } from "./watchdog.js";

let n = 0;
const check = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  n++;
  console.log(`  ✓ ${name}`);
};

// ── 1. withTimeout ──────────────────────────────────────────────────────────
// The wedge itself: a promise that never settles (half-open socket) must reject
// on the budget so the loop can continue.
await assert.rejects(
  withTimeout(new Promise<never>(() => {}), 40, "hang"),
  /exceeded 40ms/,
  "hung await rejects on the timeout budget",
);
console.log("  ✓ hung await rejects on the timeout budget");
n++;

// A fast success passes through untouched.
check("fast success passes through", (await withTimeout(Promise.resolve(42), 1000, "fast")) === 42);

// A slow-but-within-budget op still succeeds (no false timeout).
check(
  "within-budget slow op succeeds",
  (await withTimeout(new Promise((r) => setTimeout(() => r("ok"), 25)), 1000, "slow")) === "ok",
);

// An underlying rejection is forwarded (not swallowed / not masked as timeout).
await assert.rejects(
  withTimeout(Promise.reject(new Error("db down")), 1000, "err"),
  /db down/,
  "underlying rejection is forwarded",
);
console.log("  ✓ underlying rejection is forwarded");
n++;

// ── 2. shouldSelfHeal ─────────────────────────────────────────────────────────
const W = 180_000; // 3 min
check("healthy loop (failingSince=null) never heals", shouldSelfHeal(null, 9_999_999, W) === false);
check("failing 179s (< 3m) does NOT heal", shouldSelfHeal(1_000_000, 1_000_000 + 179_000, W) === false);
check("failing exactly 3m heals", shouldSelfHeal(1_000_000, 1_000_000 + 180_000, W) === true);
check("failing 10m heals", shouldSelfHeal(1_000_000, 1_000_000 + 600_000, W) === true);

// ── 3. loop-state machine (mirrors index.ts streak handling) ─────────────────
// Reproduces: a wedge (repeated failures) trips self-heal, but a success or an
// idle poll in between resets the streak so it never trips.
function simulate(outcomes: ("ok" | "idle" | "fail")[], stepMs: number, wedgeMs: number): boolean {
  let failingSince: number | null = null;
  let now = 1_000_000;
  for (const o of outcomes) {
    if (o === "fail") {
      if (failingSince === null) failingSince = now;
    } else {
      failingSince = null; // sample OR idle poll = progress
    }
    if (shouldSelfHeal(failingSince, now, wedgeMs)) return true;
    now += stepMs;
  }
  return false;
}
// 20 straight failures at 31s each = 620s > 3m → heals.
check("continuous wedge (20×31s fails) self-heals", simulate(Array(20).fill("fail"), 31_000, W) === true);
// A success midway resets the streak → never reaches 3m.
check(
  "success midway prevents self-heal",
  simulate([...Array(4).fill("fail"), "ok", ...Array(4).fill("fail")], 31_000, W) === false,
);
// Pure idle (generator outage: all idle polls) → never heals (no restart storm).
check("idle-only (generator outage) never heals", simulate(Array(50).fill("idle"), 300, W) === false);

console.log(`\nALL ${n} WATCHDOG ASSERTIONS PASSED`);
