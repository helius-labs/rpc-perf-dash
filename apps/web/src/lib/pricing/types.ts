/**
 * Type definitions for the Costs comparator.
 *
 * Pure interfaces only — no data, no logic. The data lives in *.data.ts and the
 * conversion math in simulate.ts. Imports stay relative (and shared types come
 * from @rpcbench/shared) so the whole pricing/ dir is runnable under tsx for the
 * engine test, independent of the Next `@/` path alias.
 */

import type { Method } from "@rpcbench/shared";

/** A provider's native billing unit. Display-only; USD conversion is per-plan. */
export type UnitName = "credits" | "compute_units" | "api_credits" | "requests";

/**
 * Per-method cost. "unknown" is first-class so we never encode an undocumented
 * cost as 0 (which would silently read as free). "unsupported" is *derived*
 * from providers.ts `unsupported_methods` at simulate time — data tables never
 * author it directly.
 */
export type UnitCost =
  | { kind: "units"; value: number }
  | { kind: "unsupported" }
  | { kind: "unknown" };

/** Where a number came from + when we last checked it (matches providers.ts audit convention). */
export interface Provenance {
  source_url?: string;
  /** ISO date, e.g. "2026-06-12". */
  verified_on: string;
  /** Set where the figure is not publicly listed. */
  not_public?: true;
}

/** One purchasable plan/tier for a provider. */
export interface ProviderPlan {
  /** Stable id, e.g. "helius_business". */
  id: string;
  /** FK into providers.ts ProviderRow.id (helius | triton | alchemy | quicknode). */
  providerId: string;
  /** Display name, e.g. "Business". */
  name: string;
  /** Base subscription $/mo. */
  monthlyUsd: number;
  unitName: UnitName;
  /** Native units included in monthlyUsd. null = unmetered/flat (Triton-style). */
  includedUnits: number | null;
  /** $/unit once includedUnits is exhausted. null = no overage offered / not public. */
  overageUsdPerUnit: number | null;
  /** What happens past the cap when overage isn't offered. */
  capBehavior: "overage" | "hard_cap" | "unknown";
  /** Triton-style add-ons that don't map onto credits: per-call surcharge ($/call). */
  perCallUsd?: number;
  /** Triton-style bandwidth surcharge ($/GB) — applied to RPC egress when modeled. */
  perGbUsd?: number;
  /**
   * Published throughput limit. `rps` = request/sec (Helius, QuickNode).
   * `cuPerSecond` = compute-units/sec (Alchemy's CUPS, the binding limit there;
   * `rps` may also be set as the provider's parenthetical equivalent). Absent =
   * no published limit (Triton).
   */
  rateLimits?: { rps?: number; cuPerSecond?: number; note?: string };
  /** Minimum prepaid deposit required to use the plan ($), e.g. Triton PAYG $125. */
  requiresDepositUsd?: number;
  /** Human note surfaced under the plan in the UI (e.g. "$125 min prepaid deposit"). */
  note?: string;
  provenance: Provenance;
}

/**
 * Per-method native-unit cost table for one provider. `default` applies to any
 * method not in `byMethod`, so we don't enumerate all 45 methods per provider.
 */
export interface ProviderUnitTable {
  providerId: string;
  unitName: UnitName;
  /** Cost applied when a method isn't overridden in byMethod. */
  default: UnitCost;
  byMethod: Partial<Record<Method, UnitCost>>;
  /** Optional human note about the table (e.g. archival/large-call caveats). */
  note?: string;
  /**
   * True when the provider applies per-method cost multipliers we can't model
   * because the per-method list isn't public (QuickNode's 2× "Advanced" / 4×
   * "Large Calls"). Triggers an honest "lower bound" caveat — never a guessed
   * number — when the basket contains any `multiplierMethods`.
   */
  hasUnmodeledMultipliers?: true;
  /** Heavy methods we suspect are subject to the unmodeled multipliers above. */
  multiplierMethods?: Method[];
  provenance: Provenance;
}

export type StreamKind = "websocket" | "laserstream" | "geyser" | "webhook" | "shred";

/** One streaming product offered by a provider. Axes are optional & additive. */
export interface StreamingPricing {
  providerId: string;
  kind: StreamKind;
  /** False = provider doesn't offer this stream kind (or not on a comparable tier). */
  available: boolean;
  /** Bandwidth $/GB — the dominant real axis (LaserStream/Geyser/gRPC). */
  perGbUsd?: number;
  /**
   * Bandwidth billed in native units per GB (when metered against the credit
   * pool, not $ directly) — e.g. QuickNode Solana gRPC = 100 api_credits/MB.
   * Folds into the provider's credit allotment like RPC calls do.
   */
  perGbUnits?: { unitName: UnitName; units: number };
  /** Per-message $ (e.g. webhook pushes). */
  perMessageUsd?: number;
  /** Per-message native units (when billed in credits, not $ directly). */
  perMessageUnits?: { unitName: UnitName; units: number };
  /** Per connection-second $. */
  perConnectionSecondUsd?: number;
  /** Flat monthly add-on $. */
  flatMonthlyUsd?: number;
  maxConcurrentSubscriptions?: number;
  /**
   * Minimum plan id this stream kind is available on (inclusive). Plans below
   * it (by the provider's ascending plan order) can't serve it — used to gate
   * e.g. Helius LaserStream mainnet to the Business plan or higher.
   */
  availableFromPlanId?: string;
  /**
   * Availability-matrix badge override. "beta" = offered in beta / without firm
   * public pricing (Triton Deshred; Alchemy Solana webhooks); "via_grpc" = not a
   * separate SKU, the data folds into standard gRPC (QuickNode/Alchemy shred).
   * Pricing/access detail rides in `note` (rendered as the badge tooltip).
   * Unset for the plainly-available, priced stream kinds.
   */
  availabilityStatus?: "beta" | "via_grpc";
  note?: string;
  provenance: Provenance;
}

/** A user's streaming usage for one stream kind. */
export interface StreamingUsage {
  kind: StreamKind;
  gbPerMonth?: number;
  messagesPerMonth?: number;
  connectionSeconds?: number;
  concurrentSubscriptions?: number;
}

/** The full user input: a basket of RPC calls + streaming usage. */
export interface Basket {
  /** Sparse: only methods the user dialed up. Missing = 0 calls. */
  methods: Partial<Record<Method, number>>;
  streaming: StreamingUsage[];
  /** Optional pin of a specific plan per provider; else engine auto-picks cheapest-that-fits. */
  planOverrides?: Record<string, string>;
  /**
   * Peak-to-average burst factor for the rate-limit check. The implied rate is
   * derived from monthly volume (an average) and multiplied by this to model
   * bursts. Default DEFAULT_PEAK_MULTIPLIER; clamped ≥ 1.
   */
  peakMultiplier?: number;
  /**
   * User-supplied average RPC response size, in bytes/call. Drives the "GB on
   * the wire" readout and the bandwidth surcharge on providers that bill egress
   * (Triton $0.08/GB). Absent/0 = bandwidth not modeled (the prior behavior) —
   * this is the user's own assumption, never a figure we invent.
   */
  rpcBytesPerCall?: number;
}

/** Per-result capacity/rate-limit feasibility against the chosen plan. */
export interface ProviderLimits {
  /** Plan's published request/sec limit, or null if it bills by CU/s or none. */
  rps: number | null;
  /** Plan's published compute-unit/sec limit (Alchemy), or null. */
  cuPerSecond: number | null;
  /** Peak-adjusted implied request rate from the basket volume. */
  impliedRps: number;
  /** Peak-adjusted implied compute-unit rate from the basket units. */
  impliedCuPerSecond: number;
  /** Which axis is the binding rate constraint for this plan. */
  rateBasis: "rps" | "cu_per_second" | null;
  /** Implied peak rate exceeds the plan's published limit. */
  overRate: boolean;
  /** Hard-cap plan (no overage) whose monthly allotment the basket exceeds — blocking. */
  overMonthlyCap: boolean;
  /** Basket exceeds the plan's included allotment (informational when overage covers it). */
  exceedsIncluded: boolean;
}

export type CostConfidence = "exact" | "partial" | "unavailable";

export interface MethodLineItem {
  method: Method;
  calls: number;
  unitCost: UnitCost;
  /** calls * value, or 0 when unsupported/unknown. */
  units: number;
  note?: "unsupported" | "unknown_cost";
}

export interface StreamingLineItem {
  kind: StreamKind;
  usd: number;
  /** Native units consumed (when billed in credits), folded into the provider total. */
  units: number;
  note?: "unavailable" | "unknown_cost" | "plan_gated";
}

export interface ProviderCostResult {
  providerId: string;
  /** Display name from providers.ts. */
  name: string;
  unitName: UnitName;
  /** Chosen plan; null when the provider has no usable plan (e.g. only-unknown pricing). */
  plan: ProviderPlan | null;
  /** RPC native units (sum of known line items + streaming credit usage). */
  totalUnits: number;
  includedUnits: number | null;
  overageUnits: number;
  /** RPC subscription + overage + per-call/bandwidth surcharges. */
  rpcUsd: number;
  streamingUsd: number;
  totalUsd: number;
  /** Marginal $/native-unit (overage rate, else base $/included). null when undefined. */
  marginalUsdPerUnit: number | null;
  /** RPC "on the wire" bytes ÷ 1e9, from basket.rpcBytesPerCall × calls; 0 when unset. */
  rpcBandwidthGb: number;
  breakdown: MethodLineItem[];
  streamingBreakdown: StreamingLineItem[];
  /** Capacity + rate-limit feasibility against `plan` (all-zero when plan is null). */
  limits: ProviderLimits;
  notes: string[];
  /**
   * Loud "the real bill is higher than this" flags, distinct from `notes`:
   * unmodeled heavy-call multipliers, excluded egress bandwidth, etc. Presence
   * means the total is a lower bound for the given basket.
   */
  caveats: string[];
  confidence: CostConfidence;
}

export interface SimulationOutput {
  results: ProviderCostResult[];
  basket: Basket;
}
