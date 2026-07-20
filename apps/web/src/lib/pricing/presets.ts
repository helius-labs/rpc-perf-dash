/**
 * Quick-start workload presets for the Costs comparator.
 *
 * These mirror the Overview page's SCORE_PRESETS (apps/web/src/lib/workloadPresets.ts)
 * — Balanced / Trading / Apps — so the two surfaces speak the same language.
 * Scoring needs metric weights; costs need a *call-volume* mix, so each preset
 * just spreads the monthly volume evenly across its method set. A one-click
 * starting mix + a single "monthly calls" slider beats dialing in 45 counts.
 */

import type { Method } from "@rpcbench/shared";
import { ALL_METHODS } from "../methods";
import type { Basket, StreamingUsage } from "./types";

export interface PresetOption {
  id: string;
  label: string;
  description: string;
}

interface CostPreset {
  id: string;
  label: string;
  description: string;
  /** Methods to spread the monthly volume across (equally weighted). */
  methods: readonly Method[];
  /**
   * Illustrative default streaming usage, so a preset populates the Streaming
   * sliders too — representative starting points, editable afterward, not
   * measured figures.
   */
  streaming: StreamingUsage[];
}

// Method sets match SCORE_PRESETS in lib/workloadPresets.ts.
const COST_PRESETS: readonly CostPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "An even mix across every RPC method — the neutral overall view.",
    methods: ALL_METHODS,
    streaming: [
      { kind: "websocket", messagesPerMonth: 10_000_000, concurrentSubscriptions: 100 },
      { kind: "geyser", gbPerMonth: 200 },
    ],
  },
  {
    id: "trading",
    label: "Trading",
    description: "Hot-path reads: blockhash, slot, account, and program scans.",
    methods: ["getLatestBlockhash", "getSlot", "getAccountInfo", "getProgramAccounts"],
    streaming: [
      { kind: "geyser", gbPerMonth: 2_000 },
      { kind: "websocket", messagesPerMonth: 50_000_000, concurrentSubscriptions: 50 },
    ],
  },
  {
    id: "apps",
    label: "Apps",
    description: "App reads: transactions, signatures, token and account lookups.",
    methods: [
      "getTransaction",
      "getSignaturesForAddress",
      "getProgramAccounts",
      "getTokenAccountsByOwner",
      "getAccountInfo",
      "getMultipleAccounts",
    ],
    streaming: [
      { kind: "websocket", messagesPerMonth: 10_000_000, concurrentSubscriptions: 200 },
      // Canonical gRPC kind ("geyser"); the engine prices it via each provider's
      // gRPC entry (Helius LaserStream included) through the synonym fallback.
      { kind: "geyser", gbPerMonth: 100 },
    ],
  },
];

/** Quick-start presets surfaced as buttons in the UI. */
export const PRESET_OPTIONS: readonly PresetOption[] = COST_PRESETS.map((p) => ({
  id: p.id,
  label: p.label,
  description: p.description,
}));

export const DEFAULT_MONTHLY_CALLS = 10_000_000;

/**
 * Spread a preset's volume evenly across its method set. The remainder from the
 * integer division is distributed one call at a time across the leading methods,
 * so the basket sums to EXACTLY totalMonthlyCalls regardless of method count.
 * Unknown id falls back to the first preset (Balanced).
 */
export function basketFromProfile(profileId: string, totalMonthlyCalls: number): Basket {
  const preset = COST_PRESETS.find((p) => p.id === profileId) ?? COST_PRESETS[0]!;
  const methods: Partial<Record<Method, number>> = {};
  const n = preset.methods.length;
  const total = Math.max(0, Math.floor(totalMonthlyCalls));
  if (n > 0 && total > 0) {
    const per = Math.floor(total / n);
    let remainder = total - per * n;
    for (const m of preset.methods) {
      const c = per + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      if (c > 0) methods[m] = c;
    }
  }
  const streaming = preset.streaming.map((u) => ({ ...u }));
  return { methods, streaming };
}
