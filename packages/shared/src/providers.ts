import { MIN_CONSENSUS_GROUP, MIN_CONSENSUS_VOTERS, type ConsensusFloors } from "./consensus.js";
import type { Method, SendTargetConfig, SendTargetId } from "./types.js";

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
   * Quicknode and Chainstack don't serve simulateBundle → 3 voters instead of
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

  /**
   * True if this row is a TRANSACTION-SEND target (appears on the /sends board),
   * as opposed to (or in addition to) the read `benchmarked` panel. The send
   * board selects `PROVIDERS.filter(p => p.sends)`; the read panel is unaffected.
   */
  sends?: boolean;

  /**
   * Send-path config(s) for a `sends` target. MUST live here, NOT in
   * `endpoints[]` — `PANEL_ENV_KEYS` flat-maps `endpoints[]` into the read
   * worker secret set, so a send URL there would bind onto read workers and
   * skew `isProviderConfigured`/`CONFIGURED_BENCHMARKED`. `SEND_ENV_KEYS`
   * derives from this field instead.
   */
  send_endpoints?: readonly SendTargetConfig[];
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
    // Send path: plain JSON-RPC sendTransaction on the standard read endpoint —
    // same call for every provider, no tip. See docs/methodology.md § Transaction sends.
    sends: true,
    send_endpoints: [{ name: "helius", url: "env:HELIUS_URL", protocol: "jsonrpc" }],
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
    // getTransactionsForAddress: Triton served this compatibly (byte-equal with
    // Helius and Alchemy) and then dropped it — the endpoint now returns -32601
    // "Method not found" for it, 100% of calls, while every other method on the
    // same endpoint stays healthy. Verified live 2026-08-20 (direct probe) and
    // against the fleet (all retained samples `rpc_error`, zero `correct`).
    // Left undeclared, its error body scored as a `correctness_failure` on a
    // method its tier no longer serves AND kept the panel at 2 usable voters
    // against a 3-voter floor, so every gTFA challenge fleet-wide resolved
    // `no_consensus` ("only 2 usable voter(s); need >= 3") — the method went
    // dark on the boards. Declaring it unsupported drops Triton from the
    // method's panel (2 voters: Helius, Alchemy) and, via
    // consensusFloorsForMethod() below, relaxes both consensus floors to 2.
    unsupported_methods: ["getTransactionsForAddress"],
    website: "https://triton.one",
    // Send path: plain JSON-RPC sendTransaction on the standard read endpoint, no tip.
    sends: true,
    send_endpoints: [{ name: "triton", url: "env:TRITON_URL", protocol: "jsonrpc" }],
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
    // panel (4 voters: Helius, Triton, Quicknode, Chainstack) instead of
    // scoring its error body as `incorrect`.
    unsupported_methods: ["getStakeMinimumDelegation"],
    // Send path: plain JSON-RPC sendTransaction on the standard read endpoint, no tip.
    sends: true,
    send_endpoints: [{ name: "alchemy", url: "env:ALCHEMY_URL", protocol: "jsonrpc" }],
  },
  {
    id: "quicknode",
    name: "Quicknode",
    benchmarked: true,
    utility: false,
    tier_name: "quicknode_discover",
    retention_slots: "full",
    monthly_cap: 50_000_000, // ~50M req/mo, closest binding constraint at multi-region
    endpoints: [{ url: "env:QUICKNODE_URL" }],
    data_centers: [{ locations: "undisclosed" }],
    pricing: { monthly_cost_usd: 0 },
    anti_gaming_flags: [],
    // simulateBundle is a Jito extension; Quicknode's Discover tier returns
    // -32601 (Method not found) for it. Declaring it unsupported drops Quicknode
    // from that method's panel (3 voters: Helius, Triton, Alchemy) instead of
    // penalizing it on reliability.
    //
    // getTransactionsForAddress: Quicknode serves a NON-COMPARABLE variant,
    // not an error: bare-array result instead of the
    // {data, paginationToken} envelope; always full transaction details
    // (ignores transactionDetails: "signatures"); ignores filters.slot.lte
    // (returns tip-slot entries past the pin); rejects string commitment with
    // -32602; requires maxSupportedTransactionVersion even in signatures
    // mode. Its responses can never byte-match the panel's, so it's a
    // non-voter by construction.
    unsupported_methods: ["simulateBundle", "getTransactionsForAddress"],
    website: "https://www.quicknode.com",
    notes: "Quicknode endpoint URL embeds the key.",
    // Send path: plain JSON-RPC sendTransaction on the standard read endpoint
    // (URL embeds the key), no tip — same call as every other provider.
    sends: true,
    send_endpoints: [{ name: "quicknode", url: "env:QUICKNODE_URL", protocol: "jsonrpc" }],
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
    // Send path: plain JSON-RPC sendTransaction on the standard read endpoint, no tip.
    sends: true,
    send_endpoints: [{ name: "chainstack", url: "env:CHAINSTACK_URL", protocol: "jsonrpc" }],
  },

  // The /sends board == the 5 benchmarked read providers above (each has
  // `sends: true` + a `send_endpoints` entry pointing at its standard read URL).
  // We measure plain JSON-RPC sendTransaction — no tips, no relays, no premium
  // send paths — so `PROVIDERS.filter(p => p.sends)` is exactly those 5.

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
 * the per-method panel size — `consensusFloorsForMethod()` below is the only
 * thing that turns it into consensus thresholds, so the runner and the CLI
 * can no longer drift apart on that derivation.
 */
export function structuralPanelSize(method: Method): number {
  return BENCHMARKED_PROVIDERS.filter(
    (p) => !(p.unsupported_methods?.includes(method) ?? false),
  ).length;
}

/**
 * The consensus floors for a method, derived from its structural panel size.
 * Single source of truth for both packages/runner/src/record.ts's
 * `decideForMode` (the thresholds actually applied) and apps/cli/src/mode.ts
 * (mirroring them for the CLI's report label).
 *
 *   panel ≥ 4  → { minGroup: 3, minVoters: 3 }  the default regime: a ≥3
 *                agreement group that is also a strict majority.
 *   panel = 3  → { minGroup: 2, minVoters: 3 }  all three must answer, and a
 *                2-1 split is decided in the pair's favour (the lone deviator
 *                is attributed). e.g. simulateBundle.
 *   panel ≤ 2  → { minGroup: 2, minVoters: 2 }  a pairwise agreement check:
 *                both voters must answer and agree, and a 1-1 split stays
 *                `no_consensus` because there is nothing to break the tie.
 *                e.g. getTransactionsForAddress (only Helius and Alchemy still
 *                serve it comparably). Weaker than a majority vote — two
 *                providers agreeing on the same wrong answer is
 *                indistinguishable from correct — and documented as such in
 *                docs/methodology.md; the alternative is scoring the method not
 *                at all.
 *
 * Deliberately keyed off the full static registry, not CONFIGURED_BENCHMARKED():
 * this backs both the worker/generator path (env-configured, registry ids) and
 * the CLI (`apps/cli/src/index.ts`), whose providers get synthetic `byo-N` ids
 * and typically never populate the registry's env vars at all —
 * CONFIGURED_BENCHMARKED() would collapse to empty for nearly every real CLI
 * run, silently disabling these relaxations. Known trade-off: a
 * worker/generator reproducer who deliberately configures fewer than all
 * registered providers (README explicitly allows this) gets these floors
 * computed against the full registry, not their actual subset — see
 * docs/methodology.md.
 */
export function consensusFloorsForMethod(method: Method): ConsensusFloors {
  const panel = structuralPanelSize(method);
  return {
    minGroup: panel <= 3 ? 2 : MIN_CONSENSUS_GROUP,
    // Floored at 2: a method nobody (or only one provider) serves has no
    // comparison to make, and must stay unscorable rather than letting a
    // single voter — or an empty panel — "decide".
    minVoters: Math.max(2, Math.min(panel, MIN_CONSENSUS_VOTERS)),
  };
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

// ════════════════════════════════════════════════════════════════════════
// Send targets (the /sends board)
// ════════════════════════════════════════════════════════════════════════

/** All rows flagged as transaction-send targets. */
export const SEND_PROVIDERS = PROVIDERS.filter((p) => p.sends);

/** Flat list of every send-path config across the send roster. */
export const SEND_TARGET_CONFIGS: readonly SendTargetConfig[] = SEND_PROVIDERS.flatMap(
  (p) => p.send_endpoints ?? [],
);

/** Look up a send-path config by its target id. */
export function sendTargetConfig(id: SendTargetId): SendTargetConfig | undefined {
  return SEND_TARGET_CONFIGS.find((c) => c.name === id);
}

/**
 * Every `env:VAR` name referenced by the send roster's `send_endpoints`
 * (across `url`, `headers`, `queries`, and `tip.account`). This is the single
 * source of truth for SEND_ENV_KEYS (env-keys.ts) — worker secrets that must
 * fan out to every cloud. Deduped. NOTE: `{region}`-templated public URLs with
 * no `env:` token (e.g. Helius Sender) contribute no key.
 */
export function sendEnvKeysFromRegistry(): string[] {
  const keys = new Set<string>();
  const scan = (v: string | undefined) => {
    if (v && v.startsWith("env:")) keys.add(v.slice(4));
  };
  for (const cfg of SEND_TARGET_CONFIGS) {
    scan(cfg.url);
    for (const h of Object.values(cfg.headers ?? {})) scan(h);
    for (const q of Object.values(cfg.queries ?? {})) scan(q);
    scan(cfg.tip?.account);
  }
  return Array.from(keys).sort();
}

/**
 * True if every `env:VAR` a send target's config references is resolvable in
 * the current env — i.e. the target is fully wired on this deployment.
 */
export function isSendTargetConfigured(cfg: SendTargetConfig): boolean {
  const resolvable = (v: string | undefined): boolean =>
    !v || !v.startsWith("env:") || !!process.env[v.slice(4)];
  return (
    resolvable(cfg.url) &&
    Object.values(cfg.headers ?? {}).every(resolvable) &&
    Object.values(cfg.queries ?? {}).every(resolvable) &&
    resolvable(cfg.tip?.account)
  );
}

