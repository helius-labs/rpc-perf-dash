/**
 * Per-provider plan/tier pricing.
 *
 * Point-in-time audits of each provider's published plan pages (verified_on
 * dates below), mirroring the convention in packages/shared/src/providers.ts.
 * These are public-facing list prices — re-confirm against the source_url
 * before flipping the feature flag on. Never invent a figure: where a number
 * isn't published, model it as a hard cap / unknown rather than guessing.
 *
 * Conventions:
 *  - overageUsdPerUnit is per *single* unit. Providers quote "$X / 1M", so e.g.
 *    Helius $5/1M credits → 5 / 1e6 = 5e-6.
 *  - includedUnits: null means an unmetered/flat plan (Triton); the engine then
 *    charges monthlyUsd + per-call/bandwidth surcharges, never overage.
 *  - capBehavior "hard_cap" = no overage offered on that tier (free tiers).
 */

import type { ProviderPlan } from "./types";

const HELIUS_OVERAGE = 5 / 1_000_000; // $5 per 1M credits, all paid tiers

const HELIUS_PLANS: ProviderPlan[] = [
  {
    id: "helius_free",
    providerId: "helius",
    name: "Free",
    monthlyUsd: 0,
    unitName: "credits",
    includedUnits: 1_000_000,
    overageUsdPerUnit: null,
    capBehavior: "hard_cap",
    rateLimits: { rps: 10 },
    provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "helius_developer",
    providerId: "helius",
    name: "Developer",
    monthlyUsd: 49,
    unitName: "credits",
    includedUnits: 10_000_000,
    overageUsdPerUnit: HELIUS_OVERAGE,
    capBehavior: "overage",
    rateLimits: { rps: 50 },
    provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "helius_business",
    providerId: "helius",
    name: "Business",
    monthlyUsd: 499,
    unitName: "credits",
    includedUnits: 100_000_000,
    overageUsdPerUnit: HELIUS_OVERAGE,
    capBehavior: "overage",
    rateLimits: { rps: 200 },
    provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "helius_professional",
    providerId: "helius",
    name: "Professional",
    monthlyUsd: 999,
    unitName: "credits",
    includedUnits: 200_000_000,
    overageUsdPerUnit: HELIUS_OVERAGE,
    capBehavior: "overage",
    rateLimits: { rps: 500, note: "Additional RPS purchasable at $100/RPS." },
    provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-13" },
  },
];

const ALCHEMY_PLANS: ProviderPlan[] = [
  {
    id: "alchemy_free",
    providerId: "alchemy",
    name: "Free",
    monthlyUsd: 0,
    unitName: "compute_units",
    includedUnits: 30_000_000,
    overageUsdPerUnit: null,
    capBehavior: "hard_cap",
    // Alchemy throttles on CU/s (CUPS); rps is the published parenthetical equivalent.
    rateLimits: { cuPerSecond: 500, rps: 25 },
    provenance: { source_url: "https://www.alchemy.com/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "alchemy_payg",
    providerId: "alchemy",
    name: "Pay as you go",
    monthlyUsd: 0,
    unitName: "compute_units",
    // 30M CU free, then $0.45/1M (first 300M) then $0.40/1M. We use the first
    // overage band; the cheaper >300M band is a note (engine uses one rate).
    includedUnits: 30_000_000,
    overageUsdPerUnit: 0.45 / 1_000_000,
    capBehavior: "overage",
    rateLimits: { cuPerSecond: 10_000, rps: 300 },
    note: "Overage $0.45/1M CU for the first 300M, then $0.40/1M (engine applies the $0.45 band).",
    provenance: { source_url: "https://www.alchemy.com/pricing", verified_on: "2026-06-13" },
  },
];

const QUICKNODE_PLANS: ProviderPlan[] = [
  {
    id: "quicknode_free",
    providerId: "quicknode",
    name: "Free Trial",
    monthlyUsd: 0,
    unitName: "api_credits",
    includedUnits: 10_000_000,
    overageUsdPerUnit: null,
    capBehavior: "hard_cap",
    rateLimits: { rps: 15 },
    provenance: { source_url: "https://www.quicknode.com/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "quicknode_build",
    providerId: "quicknode",
    name: "Build",
    monthlyUsd: 49,
    unitName: "api_credits",
    includedUnits: 80_000_000,
    overageUsdPerUnit: 0.62 / 1_000_000,
    capBehavior: "overage",
    rateLimits: { rps: 50 },
    provenance: { source_url: "https://www.quicknode.com/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "quicknode_accelerate",
    providerId: "quicknode",
    name: "Accelerate",
    monthlyUsd: 249,
    unitName: "api_credits",
    includedUnits: 450_000_000,
    overageUsdPerUnit: 0.55 / 1_000_000,
    capBehavior: "overage",
    rateLimits: { rps: 125 },
    provenance: { source_url: "https://www.quicknode.com/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "quicknode_scale",
    providerId: "quicknode",
    name: "Scale",
    monthlyUsd: 499,
    unitName: "api_credits",
    includedUnits: 950_000_000,
    overageUsdPerUnit: 0.53 / 1_000_000,
    capBehavior: "overage",
    rateLimits: { rps: 250 },
    provenance: { source_url: "https://www.quicknode.com/pricing", verified_on: "2026-06-13" },
  },
  {
    id: "quicknode_business",
    providerId: "quicknode",
    name: "Business",
    monthlyUsd: 999,
    unitName: "api_credits",
    includedUnits: 2_000_000_000,
    overageUsdPerUnit: 0.5 / 1_000_000,
    capBehavior: "overage",
    rateLimits: { rps: 500 },
    provenance: { source_url: "https://www.quicknode.com/pricing", verified_on: "2026-06-13" },
  },
];

const TRITON_PLANS: ProviderPlan[] = [
  {
    id: "triton_payg",
    providerId: "triton",
    name: "Pay as you go",
    monthlyUsd: 0,
    unitName: "requests",
    includedUnits: null, // unmetered: no credit allotment, billed per use
    overageUsdPerUnit: null,
    capBehavior: "overage",
    perCallUsd: 10 / 1_000_000, // $10 / 1M standard RPC calls
    perGbUsd: 0.08, // $0.08 / GB egress (applied to RPC only when the user sets an avg response size — see simulate)
    requiresDepositUsd: 125, // $125 min prepaid deposit (12-mo validity)
    rateLimits: { note: "Flexible; no published per-tier rate limit (no tier-gated throttling)." },
    note: "Prepaid PAYG: $125 min deposit (12-mo validity). Standard RPC/gRPC = $0.08/GB + $10/1M calls (the rate modeled here — all benchmarked methods are standard JSON-RPC). Triton's Metaplex/Photon ($50/1M) and Metis ($80/1M) API tiers cover DAS/compression/swap methods that aren't in the benchmarked set. Bandwidth excluded from the RPC estimate (per-call response size not modeled).",
    provenance: { source_url: "https://triton.one/pricing/", verified_on: "2026-06-13" },
  },
];

/** All plans, grouped lookups derived below. */
export const PROVIDER_PLANS: readonly ProviderPlan[] = [
  ...HELIUS_PLANS,
  ...ALCHEMY_PLANS,
  ...QUICKNODE_PLANS,
  ...TRITON_PLANS,
];

export function plansForProvider(providerId: string): ProviderPlan[] {
  return PROVIDER_PLANS.filter((p) => p.providerId === providerId);
}

export function planById(id: string): ProviderPlan | undefined {
  return PROVIDER_PLANS.find((p) => p.id === id);
}
