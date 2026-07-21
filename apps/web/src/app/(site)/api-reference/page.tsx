/**
 * Public read API reference. Documents the read-only JSON endpoints: the
 * scored/ranked data (/api/leaderboard, /api/meta, /api/by-method,
 * /api/providers/[id], /api/head-to-head) plus the data feeds and health
 * endpoints (/api/distribution, /api/challenges, /api/fleet-status,
 * /api/sample-count).
 *
 * Deliberately unlinked — there is no nav entry anywhere; it's reachable only by
 * typing the URL (and noindex'd below).
 *
 * DRIFT NOTE: only the "Valid values" lists below render live from the shared
 * constants the param parsers validate against, so those can't drift. The
 * endpoint roster, per-endpoint param tables, AND the annotated `response`
 * samples are hand-maintained — update them here whenever a route handler's
 * params or returned JSON change. The response samples were transcribed from
 * the actual route handlers / their data-layer return types; keep them honest.
 */

import type { Metadata } from "next";
import {
  GEO_REGIONS,
  WORKER_PROVIDER_LABELS,
  BENCHMARKED_PROVIDERS,
} from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { SCORE_PRESETS } from "@/lib/workloadPresets";
import { siteUrl } from "@/lib/siteUrl";
import MethodologyToc from "../methodology/MethodologyToc";
import ApiEndpointCard, { type ApiEndpoint, CodeBlock } from "./ApiEndpointCard";
import EmbedWidgetCard, { type EmbedWidget } from "./EmbedWidgetCard";

// Keep this page out of any sitemap / crawl.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "API reference",
};

/**
 * Path → anchor slug. Strips slashes and the `[id]` route brackets so dynamic
 * routes get a stable, valid id (e.g. /api/providers/[id] → api-providers-id).
 * The same slug feeds both the card's `id` and the TOC `href`.
 */
function slugify(path: string): string {
  return path
    .replace(/[/[\]]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

type EndpointSpec = Omit<ApiEndpoint, "slug">;

const ENDPOINTS: EndpointSpec[] = [
  {
    method: "GET",
    path: "/api/leaderboard",
    blurb:
      "Ranked leaderboard. Overall cross-region blend by default; a single-region board when region is concrete. The Overall board is a workload-preset method-blend (see preset) unless method= is set, which forces a legacy single-method board. Returns rank, composite score (+ L/W/R/C/F sub-scores), p50/p95/p99, win-rate, sample counts, success/correctness rates, eligibility, and failure breakdown.",
    params: [
      { name: "region", values: "overall | " + GEO_REGIONS.join(" | "), def: "overall" },
      {
        name: "preset",
        values: SCORE_PRESETS.map((p) => p.id).join(" | ") + " (Overall method-blend)",
        def: "balanced",
      },
      {
        name: "infra",
        values: Object.keys(WORKER_PROVIDER_LABELS).join(" | ") + " (concrete region only)",
        def: "pooled (__all__)",
      },
      {
        name: "method",
        values: "any method (see /api/meta) → forces single-method board",
        def: "preset blend (getTransaction when method is set)",
      },
      { name: "mode", values: "cold | warm", def: "cold" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
      { name: "eligibleOnly", values: "1 | true → drop ineligible providers", def: "off" },
    ],
    example: "/api/leaderboard?region=na-east&method=getTransaction&mode=cold&window=24",
    response: `{
  "meta": {
    "mode": "preset",          // "preset" (overall blend) | "overall" (single-method) | "region"
    "region": "overall",
    "preset": "balanced",      // null when mode != "preset"
    "infra": null,             // worker_provider key, only in region mode
    "method": "getTransaction",
    "connection_mode": "cold",
    "window_hours": 24,
    "methodology_version": 2,
    "weights": { "latency": 0.4, "winRate": 0.2, "reliability": 0.2,
                 "correctness": 0.1, "freshness": 0.1 },
    "eligible_count": 4,
    "generated_at": "2026-06-18T12:00:00.000Z"
  },
  "rows": [                    // shape varies by meta.mode; preset rows shown
    {
      "provider_id": "helius",
      "provider_name": "Helius",
      "rank": 1,               // null if ineligible in every region
      "total": 92.4,           // composite score, 0-100
      "latency_sub": 95.1, "win_sub": 88.0, "reliability_sub": 99.2,
      "correctness_sub": 100, "freshness_sub": 90.3,
      "coverage_pct": 1.0, "coverage_ok": true, "exclusion_reason": null,
      "total_wins": 812, "total_calls": 41280, "total_failed": 96,
      "total_challenges_with_winner": 1024,
      "win_rate": 0.79,        // 0-1, region+method-weighted (tracks the rank), not a pooled average
      "success_rate_calls": 0.9977,
      "failure_breakdown": [ { "category": "timeout", "n": 61 } ],
      "per_geo": { "na-east": { "total": 93.1, "latency_sub": 96.0,
                   "win_sub": 89.0, "reliability_sub": 99.4,
                   "correctness_sub": 100, "freshness_sub": 91.0 } },
      "per_method": { "getTransaction": { "total": 94.0, "p50": 41, "p95": 110 } },
      "caveat_flags": [], "caveat_explanation": ""
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/meta",
    blurb:
      "Everything needed to build a valid /api/leaderboard query: methods, regions, modes, windows, scoring weights, default region weights, min method coverage, the workload presets (method/region/component weights per preset), methodology version, the provider roster, and the currently-active geos / infra / infra×geo pairs.",
    params: [],
    example: "/api/meta",
    response: `{
  "methodology_version": 2,
  "weights": { "latency": 0.4, "winRate": 0.2, "reliability": 0.2,
               "correctness": 0.1, "freshness": 0.1 },
  "region_weights": { "na-east": 0.25, "eu-central": 0.2, "ap-northeast": 0.15 },
  "min_method_coverage": 0.6,
  "presets": [
    {
      "id": "balanced", "label": "Balanced",
      "methods": ["getTransaction", "getBlock", "..."],
      "method_weights": { "getTransaction": 0.2, "getBlock": 0.1 },
      "region_weights": { "na-east": 0.25 },
      "component_weights": { "latency": 0.4, "winRate": 0.2, "reliability": 0.2,
                             "correctness": 0.1, "freshness": 0.1 }
    }
  ],
  "methods": ["getTransaction", "getBlock", "..."],
  "geo_regions": ["na-east", "eu-central", "..."],
  "connection_modes": ["cold", "warm"],
  "windows": [ { "value": 1, "label": "1h" }, { "value": 24, "label": "24h" } ],
  "providers": [ { "id": "helius", "name": "Helius" } ],
  "active_geos": ["na-east", "eu-central"],
  "active_infra": ["aws", "gcp"],
  "active_infra_geo": [ { "worker_provider": "aws", "geo": "na-east" } ],
  "generated_at": "2026-06-18T12:00:00.000Z"
}`,
  },
  {
    method: "GET",
    path: "/api/by-method",
    blurb:
      "Per-(method × provider × cold/warm) p50 + p95 over the window, pooled across all regions. One row per (method, provider_id, connection_mode).",
    params: [
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
    ],
    example: "/api/by-method?window=24",
    response: `{
  "meta": { "window_hours": 24, "generated_at": "2026-06-18T12:00:00.000Z" },
  "rows": [
    {
      "method": "getTransaction",
      "provider_id": "helius",
      "connection_mode": "cold",
      "p50": 41,               // ms, correct-only; null if no valid samples
      "p95": 110
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/providers/[id]",
    blurb:
      "Single-provider deep dive: overall rank, composite score, per-geo sub-score breakdown, blended percentiles, win-rate, call totals, and failure breakdown, from the same Overall board /api/leaderboard returns. [id] accepts the slug or the raw provider_id; unknown ids 404.",
    params: [
      {
        name: "preset",
        values: SCORE_PRESETS.map((p) => p.id).join(" | ") + " (Overall method-blend)",
        def: "balanced",
      },
      {
        name: "method",
        values: "any method (see /api/meta) → forces single-method board",
        def: "preset blend (getTransaction when method is set)",
      },
      { name: "mode", values: "cold | warm", def: "cold" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
    ],
    example: "/api/providers/" + (BENCHMARKED_PROVIDERS[0]?.id ?? "helius"),
    response: `{
  "meta": {
    "provider_id": "helius",
    "provider_name": "Helius",
    "slug": "helius",
    "method": "getTransaction",
    "connection_mode": "cold",
    "window_hours": 24,
    "methodology_version": 2,
    "eligible_count": 4,
    "generated_at": "2026-06-18T12:00:00.000Z"
  },
  "row": {                     // null if the provider isn't on the board
    "provider_id": "helius",
    "provider_name": "Helius",
    "rank": 1,                 // null if ineligible in every region
    "total": 92.4,
    "p50_blend": 41, "p95_blend": 110, "p99_blend": 180,
    "total_wins": 812, "total_calls": 41280, "total_failed": 96,
    "total_challenges_with_winner": 1024,
    "win_rate": 0.79,          // 0-1, region+method-weighted (tracks the rank), not a pooled average
    "success_rate_calls": 0.9977,
    "failure_breakdown": [ { "category": "timeout", "n": 61 } ],
    "per_geo": { "na-east": { "total": 93.1, "latency_sub": 96.0,
                 "win_sub": 89.0, "reliability_sub": 99.4,
                 "correctness_sub": 100, "freshness_sub": 91.0 } },
    "caveat_flags": [], "caveat_explanation": ""
  }
}`,
  },
  {
    method: "GET",
    path: "/api/head-to-head",
    blurb:
      "Direct A-vs-B win rate: of the challenges BOTH providers answered correctly, how often a was faster than b (ties → earlier request start). Distinct from the leaderboard's global win rate (fastest-correct across the whole panel). Overall region-blends the per-geo rates like the leaderboard; a concrete region is a single-geo passthrough. Rates are null (with a note) when no challenge was contested — e.g. a method one provider doesn't support. a / b accept a slug or raw provider_id; unknown ids 404, and a === b is 400.",
    params: [
      {
        name: "a",
        values: BENCHMARKED_PROVIDERS.map((p) => p.id).join(" | ") + " (required)",
        def: "—",
      },
      { name: "b", values: "a different provider id (required)", def: "—" },
      { name: "method", values: "any method (see /api/meta)", def: "getTransaction" },
      { name: "mode", values: "cold | warm", def: "cold" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
      { name: "region", values: "overall | " + GEO_REGIONS.join(" | "), def: "overall" },
    ],
    example:
      "/api/head-to-head?a=helius&b=" +
      (BENCHMARKED_PROVIDERS.find((p) => p.id !== "helius")?.id ?? "quicknode") +
      "&method=getTransaction&window=24",
    response: `{
  "meta": {
    "a": "helius", "b": "quicknode",
    "a_name": "Helius", "b_name": "QuickNode",
    "a_slug": "helius", "b_slug": "quicknode",
    "method": "getTransaction",
    "connection_mode": "cold",
    "window_hours": 24,
    "region": "overall",
    "methodology_version": 3,
    "generated_at": "2026-06-18T12:00:00.000Z"
  },
  "a_win_rate": 0.62,          // 0-1, region-blended; b_win_rate = 1 - a_win_rate when contested
  "b_win_rate": 0.38,
  "a_wins": 812,               // raw summed counts (transparency; headline rate is the blend)
  "b_wins": 498,
  "n_contested": 1310          // challenges both answered correctly (= a_wins + b_wins)
  // "note": "..."             // present only when n_contested === 0
}`,
  },
  {
    method: "GET",
    path: "/api/distribution",
    blurb:
      "Latency-distribution series (CDF / histogram / box) for one method × mode × window × geo × infra, read from the precomputed latency_histogram_* tables (fast at any window). Note: region here is a GEO, not a raw cloud region; intended for lazy fetch when a user selects the distribution metric.",
    params: [
      { name: "method", values: "any method (see /api/meta)", def: "getTransaction" },
      { name: "mode", values: "cold | warm", def: "cold" },
      { name: "hours", values: WINDOWS.map((w) => w.value).join(" | ") + " (window)", def: "24" },
      { name: "region", values: GEO_REGIONS.join(" | ") + " (GEO)", def: "Overall (all geos)" },
      {
        name: "wp",
        values: Object.keys(WORKER_PROVIDER_LABELS).join(" | ") + " | all (infra)",
        def: "all (pooled)",
      },
    ],
    example: "/api/distribution?method=getTransaction&mode=cold&hours=24",
    response: `{
  "series": [                  // one entry per provider with samples
    {
      "id": "helius",
      "name": "Helius",
      "color": "#...",
      "n": 12044,              // sample count behind the distribution
      "q": [12, 18, "...", 980], // 101 percentile latencies, p0..p100 (ms)
      "p50": 41, "p95": 110, "p99": 180,
      "min": 12, "p25": 28, "p75": 70,
      "hist": [ { "bucket": 32, "cnt": 410 } ],  // log-bin histogram
      "histMax": 980,
      "winPct": 79.0           // region-weighted win rate like the leaderboard (Overall blends geos)
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/challenges",
    blurb:
      "Read-only feed of recent challenges (the verification rows behind /challenges), paginated. Returns the same slice the /challenges table renders — a bare array.",
    params: [
      { name: "method", values: "any method (see /api/meta)", def: "all" },
      { name: "bucket", values: "challenge bucket (validated downstream)", def: "all" },
      { name: "status", values: "ready | expired", def: "all" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "1" },
      { name: "target", values: "provider substring match (max 128 chars)", def: "all" },
      { name: "offset", values: "row offset, in steps of 50 (capped at 500)", def: "0" },
    ],
    example: "/api/challenges?window=1&offset=0",
    response: `[                            // bare array, newest first, page of 50
  {
    "id": "1284013",
    "method": "getTransaction",
    "bucket": "recent",
    "status": "ready",         // ready | expired
    "generated_at": "2026-06-18T11:59:30.000Z",
    "params": { "...": "method-specific challenge params" },
    "is_honeypot": false,
    "total": 4,                // responses graded for this challenge
    "correct": 4, "ambiguous": 0, "incorrect": 0
  }
]`,
  },
  {
    method: "GET",
    path: "/api/fleet-status",
    blurb:
      "Compact fleet-health summary (the data behind the header status pill). No params.",
    params: [],
    example: "/api/fleet-status",
    response: `{
  "status": "ok",             // overall fleet grade (ok | degraded | down)
  "infra": { "live": 6, "total": 6 },        // live benchmarking vantages
  "utility": { "healthy": true },            // generator chain-observation RPC
  "benchmarked": { "healthy": 4, "total": 4 } // configured provider panel
}`,
  },
  {
    method: "GET",
    path: "/api/sample-count",
    blurb:
      "Live cumulative sample count (the data behind the Overview counter). No params.",
    params: [],
    example: "/api/sample-count",
    response: `{
  "total": 48201337,          // all-time samples (this methodology version)
  "ratePerSec": 73.4          // recent rate, for client-side extrapolation
}`,
  },
];

const endpoints: ApiEndpoint[] = ENDPOINTS.map((e) => ({ ...e, slug: slugify(e.path) }));

// Embeddable widgets — the same components the dashboard renders, served
// chromeless at /embed/* for framing on other pages (live data, dark theme).
// Keep in sync with the app/(embed)/embed/* routes.
type WidgetSpec = Omit<EmbedWidget, "slug">;

const WIDGETS: WidgetSpec[] = [
  {
    id: "chart",
    title: "Comparison chart",
    blurb:
      "The full interactive latency-over-time chart — every filter the /performance chart has: Region, Infra, Window, Connection, Method, the RPC provider multi-select, plus the metric (Latency / Score / Distribution), percentile, binning and outlier toggles. All work live inside the frame. The URL params below just set the INITIAL view; providers= seeds the RPC multi-select to a head-to-head (e.g. Helius vs one competitor), still toggleable.",
    params: [
      {
        name: "providers",
        values:
          "comma-separated provider ids (" + BENCHMARKED_PROVIDERS.map((p) => p.id).join(", ") + ") — seeds the RPC multi-select",
        def: "all providers shown",
      },
      { name: "regions", values: "comma-separated geos (see /api/meta) — initial region subset", def: "all (Overall)" },
      { name: "wp", values: Object.keys(WORKER_PROVIDER_LABELS).join(" | ") + " (infra vantage)", def: "all (pooled)" },
      { name: "method", values: "comma-separated methods; a single method also enables the distribution metric", def: "getTransaction" },
      { name: "mode", values: "cold | warm", def: "cold" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
    ],
    exampleQuery: "providers=helius," + (BENCHMARKED_PROVIDERS.find((p) => p.id !== "helius")?.id ?? "alchemy"),
  },
  {
    id: "latency-table",
    title: "Method / region latency table",
    blurb:
      "Per-method and per-region latency (p50/p95 per provider). The By method / By region tabs, cold/warm, percentile, Infra dropdown and RPC-column toggles all switch client-side inside the frame; window applies at load time.",
    params: [
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
      { name: "method", values: "any method (see /api/meta) — sets the initial By-region method", def: "getTransaction" },
    ],
    exampleQuery: "",
  },
  {
    id: "leaderboard",
    title: "Ranked leaderboard",
    blurb:
      "The full ranked standings (the home board). Each row expands to a per-method × region latency grid. Honors preset + window only — methods, regions, component weights and cold mode are all derived from the preset.",
    params: [
      { name: "preset", values: SCORE_PRESETS.map((p) => p.id).join(" | "), def: "balanced" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
    ],
    exampleQuery: "preset=" + (SCORE_PRESETS.find((p) => p.id !== "balanced")?.id ?? "trading"),
  },
  {
    id: "score",
    title: "Score strip",
    blurb:
      "Compact composite-score strip (0–100 per provider). Uses the same preset blend as the leaderboard, so the ranking always agrees. Honors preset + window only.",
    params: [
      { name: "preset", values: SCORE_PRESETS.map((p) => p.id).join(" | "), def: "balanced" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "24" },
    ],
    exampleQuery: "",
  },
];

const widgets: EmbedWidget[] = WIDGETS.map((w) => ({ ...w, slug: slugify(`embed/${w.id}`) }));

const VALUES_SLUG = "valid-values";
const EMBEDS_SLUG = "embeds";

const toc = [
  ...endpoints.map((e) => ({ slug: e.slug, title: e.path })),
  { slug: EMBEDS_SLUG, title: "Embeds" },
  { slug: VALUES_SLUG, title: "Valid values" },
];

// Paste-once host listener that sizes every embed iframe to its content (matched
// by message source, so multiple widgets on one page each get their own height).
const RESIZE_LISTENER = `<script>
  addEventListener("message", (e) => {
    if (e.data?.type !== "rpcbench-embed-size") return;
    for (const f of document.querySelectorAll("iframe")) {
      if (f.contentWindow === e.source) f.style.height = e.data.height + "px";
    }
  });
</script>`;

function ValueList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="mb-3">
      <div className="mb-1 font-geistmono text-[10px] uppercase tracking-[0.08em] text-muted">
        {title}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((v) => (
          <code
            key={v}
            className="rounded bg-surface px-1.5 py-0.5 font-geistmono text-[12px] text-fg2"
          >
            {v}
          </code>
        ))}
      </div>
    </div>
  );
}

export default function ApiReferencePage() {
  const origin = siteUrl();

  return (
    <div className="pt-1">
      <header className="max-w-[820px]">
        <span className="section-kicker">API</span>
        <h1 className="mb-0 mt-2.5 text-[clamp(30px,5vw,44px)] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">
          Read API reference
        </h1>
        <p className="mt-4 max-w-[64ch] text-[15.5px] leading-[1.6] text-fg2">
          Read-only JSON endpoints serving the same scored/ranked data the dashboard
          renders. Public, no auth, cached ~30s at the edge. Prefer the visuals? Drop a
          live chart, table, leaderboard or score strip onto your page with the{" "}
          <a href={`#${EMBEDS_SLUG}`} className="text-accent hover:no-underline">
            embeddable widgets
          </a>
          .
        </p>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-[13px] text-muted">
          <li>
            Scores are <strong className="text-fg2">relative within the returned field</strong>; a
            single-provider query can&apos;t yield an absolute score.
          </li>
          <li>
            <code className="text-fg2">infra</code> is only valid with a concrete{" "}
            <code className="text-fg2">region</code> (the Overall blend is always pooled); passing
            both returns 400.
          </li>
          <li>
            <code className="text-fg2">rank</code> is <code className="text-fg2">null</code> for
            providers ineligible in every region.
          </li>
        </ul>
      </header>

      <div className="mt-8 grid grid-cols-[minmax(0,860px)] min-[1120px]:grid-cols-[200px_minmax(0,820px)] min-[1120px]:gap-x-14">
        <aside className="hidden min-[1120px]:block">
          <MethodologyToc entries={toc} />
        </aside>

        <div>
          {endpoints.map((e, i) => (
            <ApiEndpointCard key={e.slug} endpoint={e} origin={origin} defaultOpen={i === 0} />
          ))}

          <section id={EMBEDS_SLUG} className="scroll-mt-6 border-t border-line pt-6">
            <h2 className="text-lg font-semibold text-fg">Embeds</h2>
            <p className="mb-3 mt-1 max-w-[64ch] text-[13px] leading-[1.6] text-muted">
              Drop any dashboard component onto your own page as a live{" "}
              <code className="text-fg2">&lt;iframe&gt;</code>. Each widget renders the same
              components the dashboard uses, with the same ~30s-fresh data — no API wiring, no build
              step. Dark theme; the widgets&apos; own filter toggles stay interactive inside the
              frame. The embed pages are <code className="text-fg2">noindex</code> and framable on{" "}
              <code className="text-fg2">helius.dev</code>.
            </p>
            <p className="mb-3 max-w-[64ch] text-[13px] leading-[1.6] text-muted">
              Widgets report their content height to the parent, so add this listener{" "}
              <strong className="text-fg2">once</strong> to size the iframe(s) with no scrollbars:
            </p>
            <div className="mb-6">
              <CodeBlock text={RESIZE_LISTENER} />
            </div>

            {widgets.map((w, i) => (
              <EmbedWidgetCard key={w.slug} widget={w} origin={origin} defaultOpen={i === 0} />
            ))}
          </section>

          <section id={VALUES_SLUG} className="scroll-mt-6 border-t border-line pt-6 mt-8">
            <h2 className="text-lg font-semibold text-fg">Valid values</h2>
            <p className="mb-4 mt-1 text-[13px] text-muted">
              Rendered live from the same constants the endpoints validate against.
            </p>
            <ValueList title="methods" items={ALL_METHODS} />
            <ValueList title="presets" items={SCORE_PRESETS.map((p) => p.id)} />
            <ValueList title="regions" items={["overall", ...GEO_REGIONS]} />
            <ValueList title="infra (concrete region)" items={Object.keys(WORKER_PROVIDER_LABELS)} />
            <ValueList title="connection modes" items={["cold", "warm"]} />
            <ValueList title="windows (hours)" items={WINDOWS.map((w) => `${w.value} (${w.label})`)} />
            <ValueList title="providers" items={BENCHMARKED_PROVIDERS.map((p) => p.id)} />
          </section>
        </div>
      </div>
    </div>
  );
}
