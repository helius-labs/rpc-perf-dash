/**
 * Pure cost-simulation engine.
 *
 * No React, no IO — given a Basket, returns one ProviderCostResult per
 * benchmarked provider. The page renders this server-side; the test exercises
 * it under tsx. All cross-provider ranking is by USD (native units are
 * differently-defined and shown only as per-provider context).
 */

import type { Method } from "@rpcbench/shared";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import type {
  Basket,
  CostConfidence,
  MethodLineItem,
  ProviderCostResult,
  ProviderLimits,
  ProviderPlan,
  ProviderUnitTable,
  SimulationOutput,
  StreamingLineItem,
  StreamingPricing,
} from "./types";
import { plansForProvider } from "./plans.data";
import { streamingForProvider } from "./streaming.data";
import { unitTableForProvider, unitsForMethod } from "./units.data";

/** 30-day month, in seconds — converts a monthly call volume to an average rate. */
export const SECONDS_PER_MONTH = 2_592_000;
/** Default peak-to-average burst factor for the rate-limit check. */
export const DEFAULT_PEAK_MULTIPLIER = 3;

/**
 * gRPC streaming is one product class, branded per provider — Helius ships it as
 * "laserstream", the others as "geyser". A basket usage entry for either kind
 * should price against whichever the provider actually offers, so presets that
 * seed one kind don't show the other providers' gRPC as "unavailable".
 */
const GRPC_KINDS = new Set<string>(["geyser", "laserstream"]);

/** Display labels for stream kinds, used in human-readable notes. */
const STREAM_LABELS: Record<string, string> = {
  websocket: "WebSocket",
  laserstream: "LaserStream",
  geyser: "Geyser",
  webhook: "Webhooks",
  shred: "Shred",
};

/**
 * Marginal $/native-unit: overage rate if published, else effective base
 * rate (monthlyUsd / includedUnits), else a per-call surcharge (Triton).
 * Returns null when undefined — guards includedUnits being null OR 0 so we
 * never produce Infinity/NaN.
 */
export function marginalUsdPerUnit(plan: ProviderPlan): number | null {
  if (plan.overageUsdPerUnit != null) return plan.overageUsdPerUnit;
  if (plan.includedUnits != null && plan.includedUnits > 0) {
    return plan.monthlyUsd / plan.includedUnits;
  }
  if (plan.perCallUsd != null) return plan.perCallUsd;
  return null;
}

function demote(current: CostConfidence, to: CostConfidence): CostConfidence {
  const rank: Record<CostConfidence, number> = { exact: 2, partial: 1, unavailable: 0 };
  return rank[to] < rank[current] ? to : current;
}

interface PlanComputation {
  result: ProviderCostResult;
  /** False when the basket exceeds a hard-cap plan (no overage to absorb it). */
  feasible: boolean;
}

function computeForPlan(
  providerId: string,
  name: string,
  basket: Basket,
  plan: ProviderPlan,
  table: ProviderUnitTable,
  streaming: StreamingPricing[],
  unsupported: ReadonlySet<Method>,
  /** Provider's full plan list in ascending order — for streaming plan-tier gating. */
  orderedPlans: ProviderPlan[],
): PlanComputation {
  const notes: string[] = [];
  const caveats: string[] = [];
  let confidence: CostConfidence = "exact";
  // Declared up here (not just in the aggregate step) so the streaming plan-tier
  // gate below can mark a plan infeasible.
  let feasible = true;
  const planRank = orderedPlans.findIndex((p) => p.id === plan.id);

  // ── RPC method line items ───────────────────────────────────────────────
  const breakdown: MethodLineItem[] = [];
  let rpcUnits = 0;
  let totalCalls = 0;
  for (const [m, callsRaw] of Object.entries(basket.methods)) {
    const method = m as Method;
    const calls = callsRaw ?? 0;
    if (calls <= 0) continue;
    totalCalls += calls;

    if (unsupported.has(method)) {
      breakdown.push({ method, calls, unitCost: { kind: "unsupported" }, units: 0, note: "unsupported" });
      confidence = demote(confidence, "partial");
      continue;
    }
    const cost = unitsForMethod(table, method);
    if (cost.kind === "unknown") {
      breakdown.push({ method, calls, unitCost: cost, units: 0, note: "unknown_cost" });
      confidence = demote(confidence, "partial");
      continue;
    }
    if (cost.kind === "unsupported") {
      breakdown.push({ method, calls, unitCost: cost, units: 0, note: "unsupported" });
      confidence = demote(confidence, "partial");
      continue;
    }
    const units = calls * cost.value;
    rpcUnits += units;
    breakdown.push({ method, calls, unitCost: cost, units });
  }
  breakdown.sort((a, b) => b.units - a.units || b.calls - a.calls);

  // ── Streaming line items ─────────────────────────────────────────────────
  const streamingBreakdown: StreamingLineItem[] = [];
  let streamingUsd = 0;
  let streamingUnits = 0; // native units (e.g. webhook credits) folded into the total
  for (const usage of basket.streaming) {
    const gb = usage.gbPerMonth ?? 0;
    const msgs = usage.messagesPerMonth ?? 0;
    const secs = usage.connectionSeconds ?? 0;
    if (gb <= 0 && msgs <= 0 && secs <= 0) continue;

    // Exact-kind match, then fall back across the gRPC synonym group so e.g. a
    // "geyser" usage prices against Helius's "laserstream" entry (and vice versa).
    const pricing =
      streaming.find((s) => s.kind === usage.kind) ??
      (GRPC_KINDS.has(usage.kind) ? streaming.find((s) => GRPC_KINDS.has(s.kind)) : undefined);
    if (!pricing || !pricing.available) {
      streamingBreakdown.push({ kind: usage.kind, usd: 0, units: 0, note: "unavailable" });
      confidence = demote(confidence, "partial");
      continue;
    }

    // Plan-tier gate (e.g. LaserStream mainnet needs Helius Business+). A plan
    // below the gate can't serve this stream → mark the line gated and the plan
    // infeasible so auto-pick climbs to the lowest qualifying tier.
    if (pricing.availableFromPlanId) {
      const reqRank = orderedPlans.findIndex((p) => p.id === pricing.availableFromPlanId);
      if (planRank >= 0 && reqRank >= 0 && planRank < reqRank) {
        const reqName = orderedPlans[reqRank]?.name ?? "a higher";
        const label = STREAM_LABELS[usage.kind] ?? usage.kind;
        streamingBreakdown.push({ kind: usage.kind, usd: 0, units: 0, note: "plan_gated" });
        notes.push(`${label} (mainnet) requires the ${reqName} plan or higher — not available on ${plan.name}.`);
        feasible = false;
        continue;
      }
    }

    let usd = pricing.flatMonthlyUsd ?? 0;
    let units = 0;
    let pricedSomething = pricing.flatMonthlyUsd != null;
    if (gb > 0) {
      if (pricing.perGbUsd != null) {
        usd += gb * pricing.perGbUsd;
        pricedSomething = true;
      } else if (pricing.perGbUnits && pricing.perGbUnits.unitName === table.unitName) {
        // Metered against the credit pool (QuickNode gRPC) — folds into totalUnits.
        units += gb * pricing.perGbUnits.units;
        pricedSomething = true;
      }
    }
    if (msgs > 0) {
      if (pricing.perMessageUsd != null) {
        usd += msgs * pricing.perMessageUsd;
        pricedSomething = true;
      } else if (pricing.perMessageUnits && pricing.perMessageUnits.unitName === table.unitName) {
        units += msgs * pricing.perMessageUnits.units;
        pricedSomething = true;
      }
    }
    if (secs > 0 && pricing.perConnectionSecondUsd != null) {
      usd += secs * pricing.perConnectionSecondUsd;
      pricedSomething = true;
    }

    if (!pricedSomething) {
      // Stream offered but the axes the user supplied aren't separately metered.
      streamingBreakdown.push({ kind: usage.kind, usd: 0, units: 0, note: "unknown_cost" });
      confidence = demote(confidence, "partial");
      continue;
    }
    streamingUsd += usd;
    streamingUnits += units;
    streamingBreakdown.push({ kind: usage.kind, usd, units });
  }

  // ── Aggregate + USD conversion ───────────────────────────────────────────
  const totalUnits = rpcUnits + streamingUnits;
  const included = plan.includedUnits;
  const overageUnits = included == null ? 0 : Math.max(0, totalUnits - included);

  let rpcUsd = plan.monthlyUsd;
  if (overageUnits > 0) {
    if (plan.overageUsdPerUnit != null) {
      rpcUsd += overageUnits * plan.overageUsdPerUnit;
      // Overage-capable plan exceeded → informational (not blocking), per the
      // inform-not-block decision.
      notes.push(
        `Basket needs ${fmtInt(totalUnits)} ${plan.unitName}, above the ${plan.name} plan's ` +
          `${fmtInt(included ?? 0)} included — ${fmtInt(overageUnits)} billed as overage.`,
      );
    } else if (plan.capBehavior === "hard_cap") {
      feasible = false;
      notes.push(
        `Basket needs ${fmtInt(totalUnits)} ${plan.unitName} but the ${plan.name} plan caps at ${fmtInt(
          included ?? 0,
        )} with no overage — a higher tier is required.`,
      );
    } else {
      // capBehavior unknown: can't price the overage.
      feasible = false;
      confidence = demote(confidence, "partial");
      notes.push(`Overage pricing past the ${plan.name} allotment is not published.`);
    }
  }
  // Per-call surcharge (Triton-style).
  if (plan.perCallUsd != null && totalCalls > 0) {
    rpcUsd += totalCalls * plan.perCallUsd;
  }
  // RPC egress bandwidth ("GB on the wire"). Modeled ONLY when the user supplies
  // an avg response size (their own assumption — never a figure we invent), and
  // applied only to providers that bill egress on RPC (perGbUsd, e.g. Triton
  // $0.08/GB). When unset, rpcBandwidthGb = 0 and nothing changes.
  const bytesPerCall = basket.rpcBytesPerCall ?? 0;
  const rpcBandwidthGb = bytesPerCall > 0 && totalCalls > 0 ? (totalCalls * bytesPerCall) / 1e9 : 0;
  if (rpcBandwidthGb > 0 && plan.perGbUsd != null) {
    rpcUsd += rpcBandwidthGb * plan.perGbUsd;
  }

  // ── Rate-limit feasibility ────────────────────────────────────────────────
  // Implied rate = average (volume ÷ seconds/month) scaled by a peak burst factor.
  const peak = Math.max(1, basket.peakMultiplier ?? DEFAULT_PEAK_MULTIPLIER);
  const impliedRps = (totalCalls / SECONDS_PER_MONTH) * peak;
  const impliedCuPerSecond = (totalUnits / SECONDS_PER_MONTH) * peak;
  const rl = plan.rateLimits;
  let rateBasis: ProviderLimits["rateBasis"] = null;
  let overRate = false;
  if (rl?.cuPerSecond != null) {
    rateBasis = "cu_per_second";
    overRate = impliedCuPerSecond > rl.cuPerSecond;
  } else if (rl?.rps != null) {
    rateBasis = "rps";
    overRate = impliedRps > rl.rps;
  }
  if (overRate) {
    feasible = false; // auto-pick should climb to a tier that can sustain the rate
    if (rateBasis === "cu_per_second") {
      notes.push(
        `Implied peak ~${fmtInt(impliedCuPerSecond)} CU/s (avg ×${peak}) exceeds the ${plan.name} ` +
          `limit of ${fmtInt(rl?.cuPerSecond ?? 0)} CU/s — bursts will be throttled; consider a higher tier.`,
      );
    } else {
      notes.push(
        `Implied peak ~${fmtInt(impliedRps)} RPS (avg ×${peak}) exceeds the ${plan.name} ` +
          `limit of ${fmtInt(rl?.rps ?? 0)} RPS — bursts will be throttled; consider a higher tier.`,
      );
    }
  }

  const limits: ProviderLimits = {
    rps: rl?.rps ?? null,
    cuPerSecond: rl?.cuPerSecond ?? null,
    impliedRps,
    impliedCuPerSecond,
    rateBasis,
    overRate,
    overMonthlyCap: plan.capBehavior === "hard_cap" && included != null && totalUnits > included,
    exceedsIncluded: included != null && totalUnits > included,
  };

  if (plan.note) notes.push(plan.note);
  if (table.note && breakdown.some((b) => b.note === "unknown_cost")) notes.push(table.note);

  // ── Lower-bound caveats (the real bill is higher than this total) ─────────
  // Unmodeled per-method multipliers (QuickNode 2×/4×): the per-method list
  // isn't public, so heavy methods are billed at base rate — flag, never guess.
  if (table.hasUnmodeledMultipliers && table.multiplierMethods?.length) {
    const hit = table.multiplierMethods.filter((m) => (basket.methods[m] ?? 0) > 0);
    if (hit.length > 0) {
      caveats.push(
        `Lower bound — ${name} applies 2×/4× credit multipliers to some heavy methods ` +
          `(${hit.join(", ")}); the per-method list isn't public, so they're billed at the base rate here.`,
      );
    }
  }
  // Egress billed on RPC but excluded because the user hasn't set an avg response
  // size. Once they do, rpcBandwidthGb > 0 and the surcharge above applies.
  if (plan.perGbUsd != null && totalCalls > 0 && rpcBandwidthGb <= 0) {
    caveats.push(
      `Excludes ${name}'s $${plan.perGbUsd}/GB egress — set an avg response size to include "GB on the wire" bandwidth.`,
    );
  }

  const totalUsd = rpcUsd + streamingUsd;

  const result: ProviderCostResult = {
    providerId,
    name,
    unitName: table.unitName,
    plan,
    totalUnits,
    includedUnits: included,
    overageUnits,
    rpcUsd,
    streamingUsd,
    totalUsd,
    marginalUsdPerUnit: marginalUsdPerUnit(plan),
    rpcBandwidthGb,
    breakdown,
    streamingBreakdown,
    limits,
    notes,
    caveats,
    confidence,
  };
  return { result, feasible };
}

/**
 * Rank two plans by raw capability (more capable first). Used only for the
 * no-feasible-plan fallback: overage tiers (volume-unbounded) beat hard caps,
 * then higher rate limit, then larger included allotment, then higher price.
 */
function compareCapability(a: ProviderPlan, b: ProviderPlan): number {
  const overage = (p: ProviderPlan) => (p.capBehavior === "overage" || p.includedUnits == null ? 1 : 0);
  if (overage(a) !== overage(b)) return overage(b) - overage(a);
  const rate = (p: ProviderPlan) => p.rateLimits?.cuPerSecond ?? p.rateLimits?.rps ?? Infinity;
  if (rate(a) !== rate(b)) return rate(b) - rate(a);
  const incl = (p: ProviderPlan) => p.includedUnits ?? Infinity;
  if (incl(a) !== incl(b)) return incl(b) - incl(a);
  return b.monthlyUsd - a.monthlyUsd;
}

/**
 * Pick the cheapest plan that can serve the basket (honoring planOverrides).
 * Plan tiers aren't monotonic — a higher base with cheaper overage can win at
 * volume — so we evaluate every plan and take the min total among the feasible
 * ones (those that fit both the monthly cap and the rate limit).
 *
 * If NO plan fits (volume and/or rate exceed every tier), fall back to the most
 * capable plan — never the cheapest. Otherwise "auto" would sit on Free flagged
 * "over cap" instead of recommending the biggest tier available.
 */
export function pickBest(
  providerId: string,
  name: string,
  basket: Basket,
  plans: ProviderPlan[],
  table: ProviderUnitTable,
  streaming: StreamingPricing[],
  unsupported: ReadonlySet<Method>,
): ProviderCostResult | null {
  if (plans.length === 0) return null;

  const override = basket.planOverrides?.[providerId];
  const candidates = override ? plans.filter((p) => p.id === override) : plans;
  const pool = candidates.length > 0 ? candidates : plans;

  const computed = pool.map((plan) =>
    computeForPlan(providerId, name, basket, plan, table, streaming, unsupported, plans),
  );

  const feasible = computed.filter((c) => c.feasible);
  if (feasible.length > 0) {
    feasible.sort((a, b) => a.result.totalUsd - b.result.totalUsd);
    return feasible[0]!.result;
  }
  // Nothing fits — recommend the most capable tier, not the cheapest.
  const byCapability = [...computed].sort((a, b) =>
    compareCapability(a.result.plan!, b.result.plan!),
  );
  return byCapability[0]?.result ?? null;
}

/** Simulate the full basket across all benchmarked providers. */
export function simulate(basket: Basket): SimulationOutput {
  const results: ProviderCostResult[] = [];
  for (const provider of BENCHMARKED_PROVIDERS) {
    const table = unitTableForProvider(provider.id);
    const plans = plansForProvider(provider.id);
    const streaming = streamingForProvider(provider.id);
    const unsupported = new Set<Method>(provider.unsupported_methods ?? []);

    if (!table || plans.length === 0) {
      results.push(unavailableResult(provider.id, provider.name, basket));
      continue;
    }
    const best = pickBest(provider.id, provider.name, basket, plans, table, streaming, unsupported);
    results.push(best ?? unavailableResult(provider.id, provider.name, basket));
  }
  return { results, basket };
}

function unavailableResult(providerId: string, name: string, _basket: Basket): ProviderCostResult {
  return {
    providerId,
    name,
    unitName: "requests",
    plan: null,
    totalUnits: 0,
    includedUnits: null,
    overageUnits: 0,
    rpcUsd: 0,
    streamingUsd: 0,
    totalUsd: 0,
    marginalUsdPerUnit: null,
    rpcBandwidthGb: 0,
    breakdown: [],
    streamingBreakdown: [],
    limits: {
      rps: null,
      cuPerSecond: null,
      impliedRps: 0,
      impliedCuPerSecond: 0,
      rateBasis: null,
      overRate: false,
      overMonthlyCap: false,
      exceedsIncluded: false,
    },
    notes: ["No public pricing available for this provider."],
    caveats: [],
    confidence: "unavailable",
  };
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
