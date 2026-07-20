/**
 * Per-provider streaming pricing.
 *
 * Real-world streaming is priced predominantly by *bandwidth* ($/GB or $/TB),
 * not per-message — so perGbUsd is the primary axis here. Per-message /
 * per-second axes are only set where a provider publishes them (e.g. Helius
 * webhook pushes = 1 credit). Where a stream is bundled with no separate meter
 * (QuickNode), we mark it available with an unknown per-message cost rather
 * than implying it's free.
 *
 * Verified 2026-06-12. $/GB derived from published $/TB (÷1024).
 */

import type { StreamingPricing } from "./types";

const PER_GB_FROM_TB = (usdPerTb: number): number => usdPerTb / 1024;

export const STREAMING_PRICING: readonly StreamingPricing[] = [
  // ── Helius ────────────────────────────────────────────────────────────
  {
    providerId: "helius",
    kind: "laserstream",
    available: true,
    // Mainnet LaserStream requires the Business plan or higher (Free/Developer
    // are devnet-only). The comparator assumes mainnet, so gate at Business.
    availableFromPlanId: "helius_business",
    // Add-on tiers: 5TB $500 … 100TB $4,500. Smallest tier implies ~$0.098/GB;
    // larger tiers are cheaper. Sold in flat TB blocks.
    perGbUsd: 500 / (5 * 1024),
    note: "LaserStream gRPC: devnet on Developer plan+, mainnet on Business plan+ (assumed). Sold in flat TB blocks (5TB $500 → 100TB $4,500); effective $/GB drops at higher tiers.",
    provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-13" },
  },
  {
    providerId: "helius",
    kind: "webhook",
    available: true,
    perMessageUnits: { unitName: "credits", units: 1 },
    note: "Webhook pushes bill 1 credit each (folded into the RPC credit total).",
    provenance: { source_url: "https://www.helius.dev/pricing", verified_on: "2026-06-12" },
  },
  {
    providerId: "helius",
    kind: "websocket",
    available: true,
    note: "Standard/enhanced WebSocket subscriptions; message billing not separately published here.",
    provenance: { source_url: "https://www.helius.dev/docs", verified_on: "2026-06-12" },
  },
  {
    // Pre-execution / shred streaming — availability-only (not a priced axis).
    providerId: "helius",
    kind: "shred",
    available: true,
    availableFromPlanId: "helius_professional",
    note: "Shred Delivery. Preprocessed txns (gRPC) ~8 ms ahead of processed (vendor-stated): 20 credits/MB on Professional+, with 5 TB–100 TB data add-on tiers. Raw shreds (UDP) via white-glove provisioning (no public price).",
    provenance: { source_url: "https://www.helius.dev/docs/shred-delivery", verified_on: "2026-06-18" },
  },

  // ── Alchemy ───────────────────────────────────────────────────────────
  {
    providerId: "alchemy",
    kind: "geyser",
    available: true,
    perGbUsd: PER_GB_FROM_TB(75), // Solana gRPC "starting at $75/TB"
    note: "Solana gRPC starting at $75/TB (Pay-as-you-go / Enterprise).",
    provenance: { source_url: "https://www.alchemy.com/pricing", verified_on: "2026-06-12" },
  },
  {
    providerId: "alchemy",
    kind: "websocket",
    available: true,
    note: "Smart WebSockets included; per-message billed in Compute Units (not separately published).",
    provenance: { source_url: "https://www.alchemy.com/pricing", verified_on: "2026-06-12" },
  },
  {
    providerId: "alchemy",
    kind: "webhook",
    available: true,
    availabilityStatus: "beta",
    note: "Alchemy Notify webhooks (Address Activity / Custom); Solana in early beta. Included with Notify; Custom Webhooks consume compute units.",
    provenance: { source_url: "https://www.alchemy.com/docs/reference/address-activity-webhook", verified_on: "2026-06-18" },
  },
  {
    providerId: "alchemy",
    kind: "shred",
    available: false,
    availabilityStatus: "via_grpc",
    note: "No separate pre-execution product; shred-level data feeds standard Yellowstone gRPC.",
    provenance: { source_url: "https://www.alchemy.com/blog/introducing-alchemy-solana-grpc", verified_on: "2026-06-18" },
  },

  // ── QuickNode ─────────────────────────────────────────────────────────
  {
    providerId: "quicknode",
    kind: "geyser",
    available: true,
    // Yellowstone gRPC is metered at 10 API credits / 0.1 MB = 100 credits/MB.
    // Per GB (binary, matching the $/TB÷1024 convention used elsewhere here):
    // 100 × 1024 = 102,400 credits/GB, folded into the plan's credit allotment.
    perGbUnits: { unitName: "api_credits", units: 100 * 1024 },
    note: "Yellowstone gRPC metered at 10 API credits / 0.1 MB (100 cr/MB), drawn from the plan credit allotment. Access bundled on Scale/Business; Build/Accelerate need the gRPC add-on (+$499/mo, not modeled here).",
    provenance: { source_url: "https://www.quicknode.com/blog/solana-grpc-is-now-included-with-scale-and-business-plans/", verified_on: "2026-06-18" },
  },
  {
    providerId: "quicknode",
    kind: "websocket",
    available: true,
    note: "WebSocket subscriptions included on paid tiers; billed via the plan's credit allotment.",
    provenance: { source_url: "https://www.quicknode.com/pricing", verified_on: "2026-06-12" },
  },
  {
    providerId: "quicknode",
    kind: "webhook",
    available: true,
    perMessageUnits: { unitName: "api_credits", units: 30 },
    note: "QuickAlerts / Webhooks (Solana supported); 30 API credits per payload delivered, drawn from the plan credit allotment.",
    provenance: { source_url: "https://www.quicknode.com/docs/webhooks", verified_on: "2026-06-18" },
  },
  {
    providerId: "quicknode",
    kind: "shred",
    available: false,
    availabilityStatus: "via_grpc",
    note: "No separate pre-execution product; nodes are Jito ShredStream-enabled but the data feeds standard Yellowstone gRPC.",
    provenance: { source_url: "https://www.quicknode.com/solana-yellowstone-grpc", verified_on: "2026-06-18" },
  },

  // ── Triton ────────────────────────────────────────────────────────────
  {
    providerId: "triton",
    kind: "geyser",
    available: true,
    perGbUsd: 0.08, // Yellowstone gRPC / streaming = $0.08/GB
    note: "Yellowstone gRPC streaming billed at $0.08/GB egress.",
    provenance: { source_url: "https://triton.one/pricing/", verified_on: "2026-06-12" },
  },
  {
    providerId: "triton",
    kind: "websocket",
    available: true,
    perGbUsd: 0.08,
    note: "WebSocket streaming billed at $0.08/GB egress.",
    provenance: { source_url: "https://triton.one/pricing/", verified_on: "2026-06-12" },
  },
  {
    providerId: "triton",
    kind: "shred",
    available: true,
    availabilityStatus: "beta",
    note: "Deshred — pre-execution decoded txns (a Dragon's Mouth subscription type). Paid beta; contact Triton for pricing. Latency vendor-stated.",
    provenance: { source_url: "https://blog.triton.one/deshred-transactions-the-fastest-path-to-solana-data/", verified_on: "2026-06-18" },
  },
];

export function streamingForProvider(providerId: string): StreamingPricing[] {
  return STREAMING_PRICING.filter((s) => s.providerId === providerId);
}

export function streamingFor(providerId: string, kind: string): StreamingPricing | undefined {
  return STREAMING_PRICING.find((s) => s.providerId === providerId && s.kind === kind);
}
