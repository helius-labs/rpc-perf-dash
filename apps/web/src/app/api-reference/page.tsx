/**
 * Hidden internal API reference. Documents the read-only JSON endpoints:
 * the scored/ranked data (/api/leaderboard, /api/meta, /api/by-method,
 * /api/providers/[id]) plus the data feeds and health endpoints
 * (/api/distribution, /api/challenges, /api/fleet-status, /api/sample-count).
 *
 * Deliberately unlinked — there is no nav entry anywhere; it's reachable only by
 * typing the URL.
 *
 * DRIFT NOTE: only the "Valid values" lists below render live from the shared
 * constants the param parsers validate against, so those can't drift. The
 * endpoint roster and per-endpoint param tables are hand-maintained — update them
 * here whenever a route handler's params or response shape change.
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

// Keep this page out of any sitemap / crawl.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "API reference (internal)",
};

interface Param {
  name: string;
  values: string;
  def: string;
}

interface Endpoint {
  method: string;
  path: string;
  blurb: string;
  params: Param[];
  example: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/api/leaderboard",
    blurb:
      "Ranked leaderboard. Overall cross-region blend by default; a single-region board when region is concrete. The Overall board is a workload-preset method-blend (see preset) unless method= is set, which forces a legacy single-method board. Returns rank, composite score (+ L/W/R/C/F sub-scores in region mode), p50/p95/p99, win-rate, sample counts, success/correctness rates, eligibility, and failure breakdown.",
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
  },
  {
    method: "GET",
    path: "/api/meta",
    blurb:
      "Everything needed to build a valid /api/leaderboard query: methods, regions, modes, windows, scoring weights, default region weights, min method coverage, the workload presets (method/region/component weights per preset), methodology version, the provider roster, and the currently-active geos / infra / infra×geo pairs.",
    params: [],
    example: "/api/meta",
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
  },
  {
    method: "GET",
    path: "/api/providers/[id]",
    blurb:
      "Single-provider deep dive: overall rank, composite score, per-geo sub-score breakdown, blended percentiles, win-rate, call totals, and failure breakdown, from the same Overall board /api/leaderboard returns. [id] accepts the slug or the raw provider_id.",
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
  },
  {
    method: "GET",
    path: "/api/challenges",
    blurb:
      "Read-only feed of recent challenges (the verification rows behind /raw), paginated. Returns the same slice the /challenges table renders.",
    params: [
      { name: "method", values: "any method (see /api/meta)", def: "all" },
      { name: "bucket", values: "challenge bucket (validated downstream)", def: "all" },
      { name: "status", values: "ready | expired", def: "all" },
      { name: "window", values: WINDOWS.map((w) => w.value).join(" | ") + " (hours)", def: "1" },
      { name: "target", values: "provider substring match (max 128 chars)", def: "all" },
      { name: "offset", values: "row offset, in steps of 50 (capped at 500)", def: "0" },
    ],
    example: "/api/challenges?window=1&offset=0",
  },
  {
    method: "GET",
    path: "/api/fleet-status",
    blurb:
      "Compact fleet-health summary (the data behind the header status pill). No params.",
    params: [],
    example: "/api/fleet-status",
  },
  {
    method: "GET",
    path: "/api/sample-count",
    blurb:
      "Live cumulative sample count (the data behind the Overview counter). No params.",
    params: [],
    example: "/api/sample-count",
  },
];

function ValueList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="mb-3">
      <div className="text-[11px] uppercase tracking-wide text-neutral-500 mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((v) => (
          <code
            key={v}
            className="rounded bg-neutral-800 px-1.5 py-0.5 text-[12px] text-neutral-200"
          >
            {v}
          </code>
        ))}
      </div>
    </div>
  );
}

export default function ApiReferencePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12 text-neutral-200">
      <h1 className="text-2xl font-semibold text-neutral-100">Read API reference</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Read-only JSON endpoints serving the same scored/ranked data the dashboard
        renders. Public, no auth, cached ~30s at the edge.
      </p>
      <ul className="mt-3 list-disc pl-5 text-[13px] text-neutral-400 space-y-1">
        <li>
          Scores are <strong className="text-neutral-300">relative within the returned field</strong>;
          a single-provider query can&apos;t yield an absolute score.
        </li>
        <li>
          <code className="text-neutral-300">infra</code> is only valid with a concrete{" "}
          <code className="text-neutral-300">region</code> (the Overall blend is always pooled);
          passing both returns 400.
        </li>
        <li>
          <code className="text-neutral-300">rank</code> is{" "}
          <code className="text-neutral-300">null</code> for providers ineligible in every region.
        </li>
      </ul>

      {ENDPOINTS.map((e) => (
        <section key={e.path} className="mt-10 border-t border-neutral-800 pt-6">
          <div className="flex items-baseline gap-2">
            <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
              {e.method}
            </span>
            <code className="text-[15px] text-neutral-100">{e.path}</code>
          </div>
          <p className="mt-2 text-sm text-neutral-400">{e.blurb}</p>

          {e.params.length > 0 && (
            <table className="mt-4 w-full text-[13px]">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="py-1 pr-4 font-medium">param</th>
                  <th className="py-1 pr-4 font-medium">values</th>
                  <th className="py-1 font-medium">default</th>
                </tr>
              </thead>
              <tbody className="align-top">
                {e.params.map((p) => (
                  <tr key={p.name} className="border-t border-neutral-800/60">
                    <td className="py-1.5 pr-4">
                      <code className="text-neutral-200">{p.name}</code>
                    </td>
                    <td className="py-1.5 pr-4 text-neutral-400">{p.values}</td>
                    <td className="py-1.5 text-neutral-400">{p.def}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-neutral-500 mb-1">example</div>
            <code className="block rounded bg-neutral-900 border border-neutral-800 px-3 py-2 text-[12px] text-neutral-300">
              {e.example}
            </code>
          </div>
        </section>
      ))}

      <section className="mt-10 border-t border-neutral-800 pt-6">
        <h2 className="text-lg font-semibold text-neutral-100">Valid values</h2>
        <p className="mt-1 mb-4 text-[13px] text-neutral-500">
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
    </main>
  );
}
