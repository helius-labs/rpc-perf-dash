import type { Method } from "./types.js";

/**
 * Anti-gaming compliance reasons. Surfaced on the leaderboard row when a tier
 * fails to support a defense (e.g., non-rotatable API keys).
 */
export type AntiGamingFlag =
  | "non_rotatable_key"
  | "single_endpoint"
  | "undisclosed_data_centers";

export interface EndpointSpec {
  /** Provider-confirmed equivalent endpoints only. */
  url: string;
  /** URL or note explaining why this endpoint is treated as equivalent (provider docs link, support email, etc.). */
  confirmed_equivalent_to?: string;
}

export interface DataCenterDisclosure {
  /**
   * Listed PoPs/cities, or the literal string "undisclosed". Providers serve
   * Solana JSON-RPC from anycast / multi-region PoPs that they typically
   * don't publish — most entries are "undisclosed" until a provider lists
   * their PoP map publicly.
   */
  locations: readonly string[] | "undisclosed";
  source_url?: string;
}

export interface PricingInfo {
  monthly_cost_usd: number;
  per_request_usd?: number;
  /** Where pricing is not public. */
  not_public?: true;
}

export interface ProviderRow {
  /** Stable identifier used as a foreign key on samples/rollups. */
  id: string;
  /** Display name. */
  name: string;
  /** True if this provider appears on the leaderboard. */
  benchmarked: boolean;
  /** True if this provider is reserved for generator-side chain observation / derivation (never benchmarked). */
  utility: boolean;

  tier_name: string;
  /** Slot retention; "full" = archival. */
  retention_slots: number | "full";
  /** Monthly request/credit cap on this tier. null = unmetered or unknown. */
  monthly_cap: number | null;

  endpoints: readonly EndpointSpec[];
  data_centers: readonly DataCenterDisclosure[];
  pricing: PricingInfo;

  /** Anti-gaming defenses unsupported on this tier; surfaced on the dashboard. */
  anti_gaming_flags: readonly AntiGamingFlag[];

  /**
   * JSON-RPC methods this provider's tier structurally cannot serve.
   *
   * In the consensus model, a benchmarked provider listing a method here is
   * treated as a non-voter for that method (its response is a reliability
   * failure, not a correctness vote against the rest of the panel). E.g.
   * QuickNode and Chainstack don't serve simulateBundle → 3 voters instead of
   * 5 on that method, and their samples are scored on reliability only.
   *
   * Use sparingly — only when the failure is a tier-level "method not
   * available" (HTTP 403 / explicit JSON-RPC method-disabled), not a
   * transient timeout.
   */
  unsupported_methods?: readonly Method[];

  notes?: string;

  /**
   * Public marketing/homepage URL for the provider, surfaced as an outbound
   * link on the dashboard (leaderboard row + provider detail page). Display
   * only — distinct from `endpoints[].url` (the RPC endpoint) and
   * `confirmed_equivalent_to` (docs/proof). Rendered with rel="nofollow" since
   * these are competitor sites.
   */
  website?: string;
}

/**
 * POC provider registry.
 *
 * URLs/keys come from env at runtime — see `getEndpointUrl()` below.
 *
 * Tier caps / pricing fields are point-in-time audits of each provider's
 * published plan pages (see the verified-on dates in the inline comments).
 *
 * Correctness comes from majority consensus across the benchmarked panel plus
 * honeypots. The UTILITY_PROVIDER is the generator's chain-observation endpoint
 * (challenge derivation, slot polling, honeypot seeding) — it never votes and
 * needs no independence from the panel.
 */
export const PROVIDERS: readonly ProviderRow[] = [
  // ────────────────────────────────────────────────────────────
  // Benchmarked panel (votes on correctness via consensus)
  // ────────────────────────────────────────────────────────────
  {
    // The canonical Helius entry. Public route is /provider/helius.
    id: "helius",
    name: "Helius",
    benchmarked: true,
    utility: false,
    tier_name: "helius_beta",
    retention_slots: "full",
    monthly_cap: null, // beta endpoint; confirm tier when out of beta
    endpoints: [
      {
        url: "env:HELIUS_URL",
        confirmed_equivalent_to: "https://beta.helius-rpc.com",
      },
    ],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    website: "https://www.helius.dev",
    notes: "Helius beta endpoint (https://beta.helius-rpc.com).",
  },
  {
    id: "triton",
    name: "Triton",
    benchmarked: true,
    utility: false,
    tier_name: "triton_free",
    retention_slots: "full",
    monthly_cap: null,
    endpoints: [{ url: "env:TRITON_URL" }],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    website: "https://triton.one",
  },
  {
    id: "alchemy",
    name: "Alchemy",
    benchmarked: true,
    utility: false,
    tier_name: "alchemy_free",
    retention_slots: "full",
    monthly_cap: 300_000_000, // ~300M CU/mo
    endpoints: [{ url: "env:ALCHEMY_URL" }],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    website: "https://www.alchemy.com",
    // Alchemy returns -32600 "Unsupported method: getStakeMinimumDelegation on
    // SOLANA_MAINNET"; the other four serve it and agree
    // on value:1. Declaring it unsupported drops Alchemy from that method's
    // panel (4 voters: Helius, Triton, QuickNode, Chainstack) instead of
    // scoring its error body as `incorrect`.
    unsupported_methods: ["getStakeMinimumDelegation"],
  },
  {
    id: "quicknode",
    name: "QuickNode",
    benchmarked: true,
    utility: false,
    tier_name: "quicknode_discover",
    retention_slots: "full",
    monthly_cap: 50_000_000, // ~50M req/mo, closest binding constraint at multi-region
    endpoints: [{ url: "env:QUICKNODE_URL" }],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    // simulateBundle is a Jito extension; QuickNode's Discover tier returns
    // -32601 (Method not found) for it. Declaring it unsupported drops QuickNode
    // from that method's panel (3 voters: Helius, Triton, Alchemy) instead of
    // penalizing it on reliability.
    //
    // getTransactionsForAddress: QuickNode serves a NON-COMPARABLE variant,
    // not an error: bare-array result instead of the
    // {data, paginationToken} envelope; always full transaction details
    // (ignores transactionDetails: "signatures"); ignores filters.slot.lte
    // (returns tip-slot entries past the pin); rejects string commitment with
    // -32602; requires maxSupportedTransactionVersion even in signatures
    // mode. Its responses can never byte-match the panel's, so it's a
    // non-voter by construction.
    unsupported_methods: ["simulateBundle", "getTransactionsForAddress"],
    website: "https://www.quicknode.com",
    notes: "QuickNode endpoint URL embeds the key.",
  },
  {
    id: "chainstack",
    name: "Chainstack",
    benchmarked: true,
    utility: false,
    tier_name: "chainstack_free",
    retention_slots: "full",
    monthly_cap: null, // confirm cap/tier once benchmarked account is provisioned
    endpoints: [{ url: "env:CHAINSTACK_URL" }],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    // Verified live against a Chainstack mainnet endpoint (all ~45 emitted
    // methods probed): simulateBundle and getTransactionsForAddress both
    // return -32601 "Method not found" (standard Solana core RPC, no Jito
    // extension, no custom indexer). getTokenLargestAccounts returns -32601
    // "only available on dedicated nodes" — a shared/free-tier restriction,
    // same shape as the other two. Every other emitted method (including
    // getStakeMinimumDelegation) returned a valid or recognized-method
    // response. getLargestAccounts (dormant, not emitted) has the same
    // dedicated-nodes restriction as getTokenLargestAccounts.
    unsupported_methods: [
      "simulateBundle",
      "getTransactionsForAddress",
      "getTokenLargestAccounts",
    ],
    website: "https://chainstack.com",
    notes: "Chainstack Global Nodes Solana mainnet endpoint.",
  },
  // Flux removed from the benchmarked panel: it was a near-zero correctness
  // outlier across every method (e.g. getTransaction 0%, getBlock ~2.6%),
  // served stale/divergent data, and disabled getProgramAccounts. The panel is
  // now 5 benchmarked providers.

  // ────────────────────────────────────────────────────────────
  // Utility endpoint (generator chain observation)
  // ────────────────────────────────────────────────────────────
  //
  // The generator's chain-reader: challenge derivation/preflight, slot polling,
  // and honeypot ground-truth seeding. It never votes on correctness, so it
  // needs no independence from the benchmarked panel (reusing a panel member's
  // endpoint here is fine).
  {
    id: "utility",
    name: "Utility",
    benchmarked: false,
    utility: true,
    tier_name: "utility_paid",
    retention_slots: "full",
    monthly_cap: null,
    // The generator's chain-observation endpoint. Single endpoint — if it's
    // down, challenge production stalls that tick (no correctness impact) and
    // resumes when it recovers.
    endpoints: [{ url: "env:UTILITY_RPC_URL" }],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 50, not_public: true },
    anti_gaming_flags: [],
    notes: "Generator-side chain observation: challenge derivation, slot polling, and honeypot seeding. Excluded from per-provider cap accounting. Never votes on correctness.",
  },
];

export const BENCHMARKED_PROVIDERS = PROVIDERS.filter((p) => p.benchmarked);
export const UTILITY_PROVIDER = PROVIDERS.find((p) => p.utility);

/**
 * Structural voter-panel size for a method: how many of the full benchmarked
 * roster (BENCHMARKED_PROVIDERS, not a per-run configured subset) serve it,
 * i.e. don't declare it in `unsupported_methods`. Single source of truth for
 * the "is this method's structural panel exactly 3 voters" check — both
 * packages/runner/src/record.ts's `decideForMode` (deciding the actual
 * `minGroup` override) and apps/cli/src/mode.ts's `minGroupForMethod`
 * (mirroring that decision for the CLI's report label) call this instead of
 * each re-implementing the same filter, so the two can no longer drift apart.
 */
export function structuralPanelSize(method: Method): number {
  return BENCHMARKED_PROVIDERS.filter(
    (p) => !(p.unsupported_methods?.includes(method) ?? false),
  ).length;
}

/** Public dashboard-route slug for a provider (its id). */
export function providerSlug(p: ProviderRow): string {
  return p.id;
}

/** Route slug for a given provider_id (the id itself). */
export function slugForProviderId(id: string): string {
  return id;
}

/**
 * Marketing/homepage URL for a given provider_id, or undefined if none is
 * registered. Used where only the id is in hand (e.g. leaderboard rows, whose
 * row type doesn't carry the field).
 */
export function websiteForProviderId(id: string): string | undefined {
  return PROVIDERS.find((p) => p.id === id)?.website;
}

/**
 * Resolve a /provider/<param> route segment to a benchmarked provider by id.
 */
export function benchmarkedProviderByRouteParam(param: string): ProviderRow | undefined {
  return BENCHMARKED_PROVIDERS.find((p) => p.id === param);
}

/**
 * Display labels for worker-provider (cloud/infra) names. Used by the
 * leaderboard's Infra filter pill and the per-provider health strip.
 * Single source of truth so labels stay consistent across the FE.
 */
export const WORKER_PROVIDER_LABELS: Record<string, string> = {
  aws: "AWS",
  gcp: "GCP",
  teraswitch: "TeraSwitch",
  latitude: "Latitude",
  cloudflare: "Cloudflare",
  hetzner: "Hetzner",
};

if (!UTILITY_PROVIDER) {
  throw new Error("providers.ts misconfigured: no utility provider defined");
}

/**
 * Resolve an endpoint URL, replacing `env:VAR_NAME` placeholders with the
 * actual env value at runtime. Returns null when the env var is missing —
 * callers filter out unconfigured providers. Every provider URL is a full URL
 * env var (HELIUS_URL, TRITON_URL, …), so no per-provider special-casing.
 */
export function resolveEndpointUrl(spec: EndpointSpec): string | null {
  if (spec.url.startsWith("env:")) {
    const varName = spec.url.slice(4);
    const value = process.env[varName];
    if (!value) return null;
    return value;
  }
  return spec.url;
}

/**
 * Redact a resolved endpoint URL down to a host-only label for storage.
 *
 * Provider URLs routinely embed API keys in the path or query string (e.g.
 * Helius `?api-key=…`), so the full URL must never be persisted — it would turn
 * the samples table into a credential store. We keep only the host (with port),
 * which is enough to tell endpoints apart without leaking the secret. The
 * provider identity is already stored separately as `provider_id`.
 */
export function redactEndpointUrl(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** True if the provider has at least one resolvable endpoint in the current env. */
export function isProviderConfigured(p: ProviderRow): boolean {
  return p.endpoints.some((ep) => resolveEndpointUrl(ep) !== null);
}

export const CONFIGURED_BENCHMARKED = (): ProviderRow[] =>
  BENCHMARKED_PROVIDERS.filter(isProviderConfigured);

