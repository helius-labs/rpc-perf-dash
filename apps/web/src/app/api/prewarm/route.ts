/**
 * Cache pre-warmer (Vercel cron, every minute — see vercel.json). Server-fetches
 * the common /performance views so their `unstable_cache` entries and Neon's
 * page cache never go cold between the generator's 5-min ticks — so the first
 * visitor per combo (e.g. a burst from a shared link) hits a warm cache instead
 * of a multi-second cold rollup read. Reuses the exact fetchers the page uses
 * (via buildPerfSlice), so it warms the identical cache keys and adds no new
 * query shapes.
 *
 * Scope is a BOUNDED, curated set (~20 combos), NOT the full cartesian: the full
 * space is ~1000 combos (≈24 methods × 5 windows × 2 modes × 5 infra scopes),
 * which as a per-minute job would be a large standing DB load on the (OOM-prone)
 * Neon compute and couldn't finish within the cron interval when cold. Instead
 * we warm what users actually land on / click first:
 *   - default method across every window, both modes, all-infra
 *   - the top comparison methods at the default window, both modes, all-infra
 *   - each infra at the default view (24h · getTransaction · cold)
 * Everything else stays lazy (loaded on demand, then cached 120s). Raising this
 * list trades cron/DB load for broader warmth — safe to widen once Neon min-CU
 * is bumped (see docs/operations.md § Dashboard read latency).
 *
 * Guarded by CRON_SECRET (Vercel cron sends it as `Authorization: Bearer`).
 */
import { NextResponse } from "next/server";
import { BENCHMARKED_PROVIDERS, type GeoRegion, type Method } from "@rpcbench/shared";
import { WINDOWS } from "@/lib/windows";
import { fetchActiveGeos, fetchActiveProviders } from "@/lib/leaderboard";
import { buildPerfSlice } from "@/lib/perfSlice";
import { buildOverviewBoardData, buildLatencyTableData } from "@/lib/embedData";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_METHOD = "getTransaction" as Method;
const DEFAULT_WINDOW = 24;
// Top methods people compare first (mirrors the provider deep-dive's set).
const TOP_METHODS: Method[] = [
  "getTransaction" as Method,
  "getBlock" as Method,
  "getSignaturesForAddress" as Method,
];
const CONCURRENCY = 3; // cap peak parallel DB load

interface Combo {
  infra: string | null;
  mode: "cold" | "warm";
  methods: Method[];
  windowHours: number;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const started = Date.now();
  let activeGeos: GeoRegion[];
  let activeProviders: string[];
  try {
    [activeGeos, activeProviders] = await Promise.all([
      fetchActiveGeos(),
      fetchActiveProviders(),
    ]);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }

  // Build the curated combo set, de-duplicated by a stable key.
  const seen = new Set<string>();
  const combos: Combo[] = [];
  const add = (c: Combo) => {
    const k = `${c.infra ?? "all"}|${c.mode}|${c.windowHours}|${c.methods.join(",")}`;
    if (seen.has(k)) return;
    seen.add(k);
    combos.push(c);
  };
  // default method × every window × both modes × all-infra
  for (const w of WINDOWS) {
    for (const mode of ["cold", "warm"] as const) {
      add({ infra: null, mode, methods: [DEFAULT_METHOD], windowHours: w.value });
    }
  }
  // top methods × default window × both modes × all-infra
  for (const m of TOP_METHODS) {
    for (const mode of ["cold", "warm"] as const) {
      add({ infra: null, mode, methods: [m], windowHours: DEFAULT_WINDOW });
    }
  }
  // each infra at the default landing view
  for (const infra of activeProviders) {
    add({ infra, mode: "cold", methods: [DEFAULT_METHOD], windowHours: DEFAULT_WINDOW });
  }

  // Run in small batches so peak parallel DB load stays bounded.
  let warmed = 0;
  const errors: string[] = [];
  for (let i = 0; i < combos.length; i += CONCURRENCY) {
    const batch = combos.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (c) => {
        try {
          await buildPerfSlice({
            infra: c.infra,
            mode: c.mode,
            activeGeos,
            selectedGeos: [],
            methods: c.methods,
            windowHours: c.windowHours,
          });
          warmed++;
        } catch (err) {
          errors.push(
            `${c.infra ?? "all"}/${c.mode}/${c.windowHours}h/${c.methods.join("+")}: ${(err as Error).message}`,
          );
        }
      }),
    );
  }

  // Warm the /embed/* widget fetchers for the default landing view. buildPerfSlice
  // above only warms fetchLatencySeries/fetchScoreSeries, so the leaderboard/score
  // cube (fetchAggregatesForGeoByMethod) and the latency-table
  // (fetchMethodLatency/fetchMethodGeoLatency) — the expensive multi-provider
  // ranking / method×geo shapes — would otherwise stay cold. These reuse the exact
  // unstable_cache keys the embeds read, so no new query shapes. The chart embed
  // uses the same fast allVantages provider_id path as /provider/[id] (acceptable
  // cold), so it isn't warmed here.
  const tableProviders = BENCHMARKED_PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
  await Promise.all([
    buildOverviewBoardData(DEFAULT_WINDOW)
      .then(() => {
        warmed++;
      })
      .catch((err) => errors.push(`embed-board: ${(err as Error).message}`)),
    buildLatencyTableData({
      infraKeys: ["all", ...activeProviders],
      windowHours: DEFAULT_WINDOW,
      tableProviders,
    })
      .then(() => {
        warmed++;
      })
      .catch((err) => errors.push(`embed-table: ${(err as Error).message}`)),
  ]);

  return NextResponse.json(
    { ok: errors.length === 0, warmed, total: combos.length + 2, errors, ms: Date.now() - started },
    { headers: { "Cache-Control": "no-store" } },
  );
}
