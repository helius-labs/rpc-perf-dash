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
  /**
   * Optional URL slug for the dashboard route (/provider/<slug>). Defaults to
   * `id`. Lets a provider whose `id` is frozen as a DB foreign key (e.g.
   * `helius_gatekeeper`) present a clean public URL (`/provider/helius`)
   * without migrating millions of sample rows.
   */
  slug?: string;
  /** True if this provider appears on the leaderboard. */
  benchmarked: boolean;
  /** True if this provider is reserved for generator-side preflight / auditor (never benchmarked). */
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
   * QuickNode doesn't serve simulateBundle → 3 voters instead of 4 on that
   * method, and QuickNode's sample is scored on reliability only.
   *
   * Use sparingly — only when the failure is a tier-level "method not
   * available" (HTTP 403 / explicit JSON-RPC method-disabled), not a
   * transient timeout.
   */
  unsupported_methods?: readonly Method[];

  notes?: string;
}

/**
 * POC provider registry.
 *
 * URLs/keys come from env at runtime — see `getEndpointUrl()` below.
 *
 * Tier caps / pricing fields are point-in-time audits of each provider's
 * published plan pages (see the verified-on dates in the inline comments).
 *
 * Correctness comes from majority consensus across the benchmarked panel
 * (there is no rotating neutral quorum), with the UTILITY_PROVIDER serving
 * as an independent auditor tripwire.
 * The auditor's endpoint operator MUST be independent of every benchmarked
 * provider — see `assertAuditorIndependent()` below.
 */
export const PROVIDERS: readonly ProviderRow[] = [
  // ────────────────────────────────────────────────────────────
  // Benchmarked panel (votes on correctness via consensus)
  // ────────────────────────────────────────────────────────────
  {
    // Helius public free tier — retired from the leaderboard once the
    // Gatekeeper endpoint became the canonical "Helius" entry on the
    // leaderboard. Kept in the registry so historical samples and DB rows
    // referencing provider_id="helius" still resolve, but workers no longer
    // sample it (benchmarked: false) and it doesn't appear on the dashboard.
    id: "helius",
    name: "Helius (legacy free tier)",
    benchmarked: false,
    utility: false,
    tier_name: "helius_free",
    retention_slots: "full",
    monthly_cap: 1_000_000, // ~1M credits/mo public free tier
    endpoints: [
      {
        url: "env:HELIUS_API_KEY",
        confirmed_equivalent_to: "https://docs.helius.dev/reference/rpc",
      },
    ],
    data_centers: [
      {
        locations: "undisclosed",
      },
    ],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    notes: "Costs the panel operator $0 to operate; reproducers pay their provider's rates. See methodology § Operator vs reproducer cost.",
  },
  {
    // ID stays "helius_gatekeeper" because it's a foreign key on millions of
    // existing samples / rollups rows. Display name is just "Helius" — this
    // is the leaderboard's canonical Helius entry now.
    id: "helius_gatekeeper",
    name: "Helius",
    // Public route is /provider/helius even though the id stays frozen.
    slug: "helius",
    benchmarked: true,
    utility: false,
    tier_name: "helius_gatekeeper_beta",
    retention_slots: "full",
    monthly_cap: null, // beta endpoint; confirm tier when out of beta
    endpoints: [
      {
        url: "env:HELIUS_GATEKEEPER_URL",
        confirmed_equivalent_to: "https://beta.helius-rpc.com",
      },
    ],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    notes: "Helius beta gatekeeper endpoint (https://beta.helius-rpc.com). Separate from the public free-tier Helius entry; uses the same API key but routes through a different ingress path.",
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
    // Alchemy returns -32600 "Unsupported method: getStakeMinimumDelegation on
    // SOLANA_MAINNET"; the other three serve it and agree
    // on value:1. Declaring it unsupported drops Alchemy from that method's
    // panel (3 voters: Helius, Triton, QuickNode) instead of scoring its error
    // body as `incorrect`.
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
    notes: "QuickNode endpoint URL embeds the key.",
  },
  // Flux removed from the benchmarked panel: it was a near-zero correctness
  // outlier across every method (e.g. getTransaction 0%, getBlock ~2.6%),
  // served stale/divergent data, and disabled getProgramAccounts. The panel is
  // now 4 benchmarked providers.

  // ────────────────────────────────────────────────────────────
  // Utility endpoint (generator preflight + neutral auditor)
  // ────────────────────────────────────────────────────────────
  //
  // Doubles as the independent AUDITOR in the consensus model: per-challenge
  // cross-check against panel consensus, and deferred finality re-verification.
  // The endpoint operator MUST be independent of every benchmarked panel
  // member or the auditor cross-check is hollow. Enforce via env config + the
  // `assertAuditorIndependent()` runtime check below.
  {
    id: "utility",
    name: "Utility / Auditor",
    benchmarked: false,
    utility: true,
    tier_name: "utility_paid",
    retention_slots: "full",
    monthly_cap: null,
    // Multiple endpoints so the generator can fail over when one provider
    // 403s / 5xxs / disappears. UTILITY_RPC_URL is required; the _2 and _3
    // slots are optional — unset slots are skipped by the multi-endpoint
    // client at runtime (apps/generator/src/utility-client.ts).
    endpoints: [
      { url: "env:UTILITY_RPC_URL" },
      { url: "env:UTILITY_RPC_URL_2" },
      { url: "env:UTILITY_RPC_URL_3" },
    ],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 50, not_public: true },
    anti_gaming_flags: [],
    notes: "Generator-side preflight + neutral auditor for the consensus cross-check. Excluded from per-provider cap accounting. Endpoint operator MUST be independent of the benchmarked panel (see assertAuditorIndependent).",
  },
];

export const BENCHMARKED_PROVIDERS = PROVIDERS.filter((p) => p.benchmarked);
export const UTILITY_PROVIDER = PROVIDERS.find((p) => p.utility);

/** Public dashboard-route slug for a provider — `slug` if set, else the id. */
export function providerSlug(p: ProviderRow): string {
  return p.slug ?? p.id;
}

/** Route slug for a given provider_id (used when only the id is in hand). */
export function slugForProviderId(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.slug ?? id;
}

/**
 * Resolve a /provider/<param> route segment to a benchmarked provider. Matches
 * either the slug or the raw id, so both /provider/helius (canonical) and
 * /provider/helius_gatekeeper (legacy/bookmarked) resolve to the same row.
 */
export function benchmarkedProviderByRouteParam(param: string): ProviderRow | undefined {
  return BENCHMARKED_PROVIDERS.find((p) => providerSlug(p) === param || p.id === param);
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
 * callers filter out unconfigured providers.
 *
 * Helius special case: HELIUS_API_KEY is conventionally a bare key, not a
 * full URL. We build the canonical URL from it.
 */
export function resolveEndpointUrl(spec: EndpointSpec): string | null {
  if (spec.url.startsWith("env:")) {
    const varName = spec.url.slice(4);
    const value = process.env[varName];
    if (!value) return null;
    if (varName === "HELIUS_API_KEY") {
      // Bare key → full Helius RPC URL. If the user set the full URL anyway,
      // pass through untouched.
      return value.startsWith("http") ? value : `https://mainnet.helius-rpc.com/?api-key=${value}`;
    }
    return value;
  }
  return spec.url;
}

/** True if the provider has at least one resolvable endpoint in the current env. */
export function isProviderConfigured(p: ProviderRow): boolean {
  return p.endpoints.some((ep) => resolveEndpointUrl(ep) !== null);
}

export const CONFIGURED_BENCHMARKED = (): ProviderRow[] =>
  BENCHMARKED_PROVIDERS.filter(isProviderConfigured);

/**
 * Hard requirement for the auditor's cross-check to be meaningful: none of the
 * configured auditor (utility) endpoint hostnames may overlap with a
 * benchmarked provider's hostname. Called at generator startup.
 *
 * Caveat: this is a HOST-STRING check only. It cannot detect shared upstream
 * infrastructure behind a distinct hostname, so confirming the configured
 * endpoint's real operator remains a manual operational prerequisite.
 *
 * Throws (fail-closed) so a misconfigured deploy is loud, not silently
 * neutered.
 *
 * ── TEMPORARY OVERRIDE ───────────────────────────────────────────────────
 * Setting `AUDITOR_PANEL_OVERLAP_OK=1` downgrades the failure to a loud
 * console warning and lets the generator start with a panel-member auditor.
 * Tradeoff: the auditor cross-check becomes self-refereeing for any
 * challenge served by the overlapping panel member, so `consensus_disputed`
 * is no longer a meaningful tripwire on that traffic. The finality
 * re-verification metric on the dashboard still has integrity (it re-checks
 * against canonical on-chain truth post-finality), so partial coverage
 * remains.
 *
 * This override is a *stopgap* — set when no panel-independent auditor URL
 * is provisioned yet (e.g. waiting on a paid third-party endpoint). Remove
 * it once a real neutral auditor (self-run or any provider explicitly not
 * on the panel) is configured in UTILITY_RPC_URL. See docs/operations.md
 * § Roadmap.
 */
export function assertAuditorIndependent(): void {
  if (!UTILITY_PROVIDER) {
    throw new Error("[auditor-check] no UTILITY_PROVIDER configured");
  }
  const benchHosts = new Set<string>();
  for (const p of BENCHMARKED_PROVIDERS) {
    for (const ep of p.endpoints) {
      const url = resolveEndpointUrl(ep);
      if (!url) continue;
      try {
        benchHosts.add(new URL(url).hostname.toLowerCase());
      } catch {
        // unresolvable url — ignore for the overlap check
      }
    }
  }
  const overlaps: Array<{ env_var: string; host: string }> = [];
  for (const ep of UTILITY_PROVIDER.endpoints) {
    const url = resolveEndpointUrl(ep);
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (benchHosts.has(host)) {
      const m = /^env:(.+)$/.exec(ep.url);
      overlaps.push({ env_var: m?.[1] ?? "?", host });
    }
  }
  if (overlaps.length > 0) {
    const lines = overlaps
      .map((o) => `  ${o.env_var} → ${o.host} (also a benchmarked provider host)`)
      .join("\n");
    const msg =
      `auditor endpoint(s) overlap with the benchmarked panel — the consensus cross-check is not independent:\n${lines}`;
    if (process.env.AUDITOR_PANEL_OVERLAP_OK === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `[auditor-check] WARN ${msg}\n` +
          `[auditor-check] AUDITOR_PANEL_OVERLAP_OK=1 → proceeding anyway. ` +
          `Provision a panel-independent auditor URL and unset this override.`,
      );
      return;
    }
    throw new Error(
      `[auditor-check] ${msg}\n` +
        `Reconfigure UTILITY_RPC_URL / _2 / _3 to a provider that is NOT on the leaderboard, ` +
        `or set AUDITOR_PANEL_OVERLAP_OK=1 as a temporary stopgap.`,
    );
  }
}
