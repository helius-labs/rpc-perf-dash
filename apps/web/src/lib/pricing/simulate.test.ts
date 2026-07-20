/**
 * Engine tests for the Costs comparator. No test framework is configured in
 * this repo (typecheck-only); these run on node:test via tsx:
 *
 *   pnpm --filter web test          # runs this file
 *   npx tsx --test apps/web/src/lib/pricing/simulate.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { simulate, marginalUsdPerUnit } from "./simulate";
import { basketFromProfile } from "./presets";
import { parseBasket } from "./basket";
import type { Basket, ProviderCostResult, ProviderPlan } from "./types";

const APPROX = 1e-6;
const byId = (out: ProviderCostResult[], id: string): ProviderCostResult => {
  const r = out.find((x) => x.providerId === id);
  assert.ok(r, `missing result for ${id}`);
  return r;
};

test("simulate returns one result per benchmarked provider", () => {
  const { results } = simulate({ methods: {}, streaming: [] });
  const ids = results.map((r) => r.providerId).sort();
  assert.deepEqual(ids, ["alchemy", "helius", "quicknode", "triton"]);
});

test("Helius: 100M getAccountInfo (1 credit each) → cheapest plan $499", () => {
  const basket: Basket = { methods: { getAccountInfo: 100_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.totalUnits, 100_000_000);
  assert.equal(r.confidence, "exact");
  // Developer: $49 + 90M*$5e-6 = $499. Business: $499 flat. Either is the min.
  assert.ok(Math.abs(r.totalUsd - 499) < 1e-3, `got ${r.totalUsd}`);
  assert.equal(r.marginalUsdPerUnit, 5e-6);
});

test("Helius: getProgramAccounts costs 10 credits each", () => {
  const basket: Basket = { methods: { getProgramAccounts: 100_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.totalUnits, 1_000_000_000); // 100M * 10
  // every paid tier lands at $4,999 here (cheaper base ↔ more overage cancel out)
  assert.ok(Math.abs(r.totalUsd - 4999) < 1e-3, `got ${r.totalUsd}`);
});

test("Alchemy: undocumented method (getBlockProduction) is unknown, not free", () => {
  const basket: Basket = { methods: { getBlockProduction: 1000 }, streaming: [] };
  const r = byId(simulate(basket).results, "alchemy");
  assert.equal(r.confidence, "partial");
  const line = r.breakdown.find((b) => b.method === "getBlockProduction");
  assert.equal(line?.note, "unknown_cost");
  assert.equal(line?.units, 0);
});

test("QuickNode: getTransactionsForAddress is unsupported → demotes confidence, 0 units", () => {
  const basket: Basket = { methods: { getTransactionsForAddress: 1000 }, streaming: [] };
  const r = byId(simulate(basket).results, "quicknode");
  assert.equal(r.confidence, "partial");
  const line = r.breakdown.find((b) => b.method === "getTransactionsForAddress");
  assert.equal(line?.note, "unsupported");
  assert.equal(r.totalUnits, 0);
});

test("Triton: billed per-call, not per-credit ($10 / 1M calls)", () => {
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "triton");
  assert.equal(r.totalUnits, 1_000_000); // unit = request
  assert.ok(Math.abs(r.totalUsd - 10) < APPROX, `got ${r.totalUsd}`);
  assert.equal(r.marginalUsdPerUnit, 1e-5);
});

test("Triton: streaming bandwidth billed at $0.08/GB", () => {
  const basket: Basket = { methods: {}, streaming: [{ kind: "geyser", gbPerMonth: 100 }] };
  const r = byId(simulate(basket).results, "triton");
  assert.ok(Math.abs(r.streamingUsd - 8) < APPROX, `got ${r.streamingUsd}`); // 100 * 0.08
});

test("QuickNode: gRPC bandwidth meters credits (10 cr/0.1MB = 102,400 cr/GB)", () => {
  const basket: Basket = { methods: {}, streaming: [{ kind: "geyser", gbPerMonth: 1000 }] };
  const r = byId(simulate(basket).results, "quicknode");
  // 1000 GB folds into the credit pool — not a $/GB charge like Triton.
  assert.equal(r.totalUnits, 1000 * 100 * 1024);
  const line = r.streamingBreakdown.find((s) => s.kind === "geyser");
  assert.ok(line && line.units > 0 && line.usd === 0, "geyser metered in credits, not USD");
});

test("marginalUsdPerUnit guards includedUnits null and 0 (no Infinity/NaN)", () => {
  const base: ProviderPlan = {
    id: "x",
    providerId: "x",
    name: "x",
    monthlyUsd: 100,
    unitName: "credits",
    includedUnits: 0,
    overageUsdPerUnit: null,
    capBehavior: "hard_cap",
    provenance: { verified_on: "2026-06-12" },
  };
  assert.equal(marginalUsdPerUnit(base), null); // 0 included → null, not Infinity
  assert.equal(marginalUsdPerUnit({ ...base, includedUnits: null }), null);
  assert.equal(marginalUsdPerUnit({ ...base, includedUnits: 0, perCallUsd: 2e-5 }), 2e-5);
  assert.equal(marginalUsdPerUnit({ ...base, includedUnits: 1000, overageUsdPerUnit: null }), 0.1);
});

test("preset expansion sums to the requested call volume (exact, any method count)", () => {
  // Balanced spreads across all 45 methods — remainder distribution must still
  // sum exactly. Trading (4 methods) divides evenly. Check both.
  for (const id of ["balanced", "trading", "apps"]) {
    const b = basketFromProfile(id, 1_000_000);
    const sum = Object.values(b.methods).reduce((a, c) => a + (c ?? 0), 0);
    assert.equal(sum, 1_000_000, `preset ${id}`);
  }
});

test("plan-aware vs marginal can diverge (Helius marginal is the overage rate)", () => {
  const basket: Basket = { methods: { getAccountInfo: 100_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "helius");
  // marginal ($5e-6/credit) * 100M = $500 ≠ plan-aware $499 (the included credits matter)
  const marginalTotal = (r.marginalUsdPerUnit ?? 0) * r.totalUnits;
  assert.ok(Math.abs(marginalTotal - 500) < 1e-3);
  assert.notEqual(Math.round(marginalTotal), Math.round(r.totalUsd));
});

// ── Capacity + rate-limit feasibility ───────────────────────────────────────

test("rate limit: 200M calls @ peak 3× pushes Helius auto-pick to Professional", () => {
  // 200M/mo ≈ 77 RPS avg → ~231 RPS peak. Business (200 RPS) is over rate; only
  // Professional (500 RPS) sustains it, even though both cost ~$999.
  const basket: Basket = { methods: { getAccountInfo: 200_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_professional");
  assert.equal(r.limits.overRate, false);
});

test("rate limit: pinning Business for that basket flags overRate + a note", () => {
  const basket: Basket = {
    methods: { getAccountInfo: 200_000_000 },
    streaming: [],
    planOverrides: { helius: "helius_business" },
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_business");
  assert.equal(r.limits.overRate, true);
  assert.equal(r.limits.rateBasis, "rps");
  assert.ok(r.notes.some((n) => /exceeds the Business.*RPS/i.test(n)));
});

test("rate limit: peakMultiplier 1 clears the over-rate on Business", () => {
  const basket: Basket = {
    methods: { getAccountInfo: 200_000_000 },
    streaming: [],
    planOverrides: { helius: "helius_business" },
    peakMultiplier: 1,
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.limits.overRate, false); // 77 RPS avg < 200 RPS Business limit
});

test("no feasible plan: auto falls back to the MOST capable tier, never Free", () => {
  // 5B calls/mo → ~5,787 RPS peak, above every Helius tier's limit, so no plan
  // fits. Auto must land on Professional (the max tier), not Free.
  const basket: Basket = { methods: { getAccountInfo: 5_000_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_professional");
  assert.notEqual(r.plan?.id, "helius_free");
});

test("hard cap: basket above Helius Free (1M) with Free pinned is over cap (blocking)", () => {
  const basket: Basket = {
    methods: { getAccountInfo: 2_000_000 },
    streaming: [],
    planOverrides: { helius: "helius_free" },
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_free");
  assert.equal(r.limits.overMonthlyCap, true);
});

test("overage is informational: exceeds included but not over cap or rate", () => {
  // 20M calls → exceeds Developer's 10M included (overage), ~23 RPS peak < 50 RPS limit.
  const basket: Basket = {
    methods: { getAccountInfo: 20_000_000 },
    streaming: [],
    planOverrides: { helius: "helius_developer" },
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.limits.exceedsIncluded, true);
  assert.equal(r.limits.overMonthlyCap, false);
  assert.equal(r.limits.overRate, false);
});

test("LaserStream gate: a tiny basket + LaserStream forces Helius auto to Business+", () => {
  // RPC volume alone would fit Free, but mainnet LaserStream needs Business+,
  // so Free/Developer are infeasible → auto must pick Business.
  const basket: Basket = {
    methods: { getAccountInfo: 100_000 },
    streaming: [{ kind: "laserstream", gbPerMonth: 1_000 }],
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_business");
  assert.ok(r.streamingUsd > 0); // LaserStream priced on Business
});

test("LaserStream gate: pinning Developer flags the stream as plan-gated", () => {
  const basket: Basket = {
    methods: { getAccountInfo: 100_000 },
    streaming: [{ kind: "laserstream", gbPerMonth: 1_000 }],
    planOverrides: { helius: "helius_developer" },
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_developer");
  const line = r.streamingBreakdown.find((s) => s.kind === "laserstream");
  assert.equal(line?.note, "plan_gated");
  assert.ok(r.notes.some((n) => /LaserStream.*Business.*or higher/i.test(n)));
});

test("gRPC synonym: a geyser usage prices against Helius's LaserStream entry", () => {
  // Helius only carries a "laserstream" entry; a basket seeding the generic
  // "geyser" kind must still price (and gate to Business+), not show unavailable.
  const basket: Basket = {
    methods: { getAccountInfo: 100_000 },
    streaming: [{ kind: "geyser", gbPerMonth: 1_000 }],
  };
  const r = byId(simulate(basket).results, "helius");
  assert.equal(r.plan?.id, "helius_business"); // gated up via the laserstream entry
  assert.ok(r.streamingUsd > 0);
  const line = r.streamingBreakdown.find((s) => s.kind === "geyser");
  assert.ok(line && line.usd > 0, "geyser usage priced via laserstream");
});

test("gRPC synonym: a laserstream usage prices against Alchemy's geyser entry", () => {
  const basket: Basket = {
    methods: {},
    streaming: [{ kind: "laserstream", gbPerMonth: 1_000 }],
  };
  const r = byId(simulate(basket).results, "alchemy");
  assert.ok(Math.abs(r.streamingUsd - 1000 * (75 / 1024)) < 1e-3, `got ${r.streamingUsd}`);
});

test("Alchemy getProgramAccounts is a known 20 CU (not unknown)", () => {
  const basket: Basket = { methods: { getProgramAccounts: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "alchemy");
  assert.equal(r.totalUnits, 1_000_000 * 20);
  assert.equal(r.confidence, "exact"); // no unknown-cost demotion
  assert.ok(!r.breakdown.some((b) => b.note === "unknown_cost"));
});

test("QuickNode webhooks meter 30 credits per payload", () => {
  const basket: Basket = { methods: {}, streaming: [{ kind: "webhook", messagesPerMonth: 1_000_000 }] };
  const r = byId(simulate(basket).results, "quicknode");
  assert.equal(r.totalUnits, 1_000_000 * 30); // folded into the credit pool
  const line = r.streamingBreakdown.find((s) => s.kind === "webhook");
  assert.ok(line && line.units > 0 && line.usd === 0, "webhook metered in credits");
});

test("Alchemy rate check uses CU/s (cu_per_second basis)", () => {
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "alchemy");
  assert.equal(r.limits.rateBasis, "cu_per_second");
});

test("peak= parses and clamps from the URL", () => {
  assert.equal(parseBasket({ peak: "5" }).peakMultiplier, 5);
  assert.equal(parseBasket({ peak: "0.5" }).peakMultiplier, undefined); // < 1 rejected → engine default
  assert.equal(parseBasket({ peak: "99999" }).peakMultiplier, 1000); // clamped
});

// ── Opt-in RPC bandwidth ("GB on the wire") ─────────────────────────────────

test("rpcBytesPerCall unset → Triton total unchanged, rpcBandwidthGb 0 (no regression)", () => {
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "triton");
  assert.equal(r.rpcBandwidthGb, 0);
  assert.ok(Math.abs(r.totalUsd - 10) < APPROX, `got ${r.totalUsd}`); // still just $10/1M calls
});

test("rpcBytesPerCall set → Triton bills egress at $0.08/GB on top of per-call", () => {
  // 1M calls × 10_000 bytes = 1e10 bytes = 10 GB → +$0.80 egress on top of $10.
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [], rpcBytesPerCall: 10_000 };
  const r = byId(simulate(basket).results, "triton");
  assert.ok(Math.abs(r.rpcBandwidthGb - 10) < APPROX, `gb ${r.rpcBandwidthGb}`);
  assert.ok(Math.abs(r.totalUsd - 10.8) < APPROX, `got ${r.totalUsd}`); // 10 + 10*0.08
});

test("rpcBytesPerCall set → credit-based providers add bandwidth GB but no egress charge", () => {
  // Helius bills credits, not egress (no perGbUsd), so bandwidth is reported but free.
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [], rpcBytesPerCall: 10_000 };
  const before = byId(simulate({ methods: { getAccountInfo: 1_000_000 }, streaming: [] }).results, "helius");
  const after = byId(simulate(basket).results, "helius");
  assert.ok(Math.abs(after.rpcBandwidthGb - 10) < APPROX, `gb ${after.rpcBandwidthGb}`);
  assert.equal(after.totalUsd, before.totalUsd); // no egress surcharge for Helius
});

// ── Lower-bound caveats (flag, never fabricate) ─────────────────────────────

test("QuickNode heavy method → lower-bound caveat present, confidence still exact", () => {
  const basket: Basket = { methods: { getProgramAccounts: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "quicknode");
  assert.equal(r.confidence, "exact"); // getProgramAccounts has a known base cost (30), not unknown
  assert.ok(r.caveats.some((c) => /multipliers/i.test(c)), `caveats: ${r.caveats.join(" | ")}`);
});

test("QuickNode without a heavy method → no multiplier caveat", () => {
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "quicknode");
  assert.ok(!r.caveats.some((c) => /multipliers/i.test(c)));
});

test("Triton with calls and no response size → bandwidth-excluded caveat", () => {
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [] };
  const r = byId(simulate(basket).results, "triton");
  assert.ok(r.caveats.some((c) => /egress/i.test(c)), `caveats: ${r.caveats.join(" | ")}`);
});

test("Triton with a response size set → bandwidth caveat clears (it's now modeled)", () => {
  const basket: Basket = { methods: { getAccountInfo: 1_000_000 }, streaming: [], rpcBytesPerCall: 10_000 };
  const r = byId(simulate(basket).results, "triton");
  assert.ok(!r.caveats.some((c) => /egress/i.test(c)));
});

test("bytes= parses and clamps from the URL", () => {
  assert.equal(parseBasket({ bytes: "4096" }).rpcBytesPerCall, 4096);
  assert.equal(parseBasket({ bytes: "0" }).rpcBytesPerCall, undefined); // 0 = off
  assert.equal(parseBasket({ bytes: "999999999" }).rpcBytesPerCall, 100_000_000); // clamped to MAX
});
