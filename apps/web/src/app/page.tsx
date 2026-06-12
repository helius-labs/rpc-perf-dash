import Link from "next/link";
import type { Route } from "next";
import {
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { type MethodRegionLatency } from "@/components/IndexLeaderboard";
import { OverviewBoard } from "@/components/OverviewBoard";
import { fetchActiveGeos, fetchAggregatesForGeo } from "@/lib/leaderboard";
import { fetchSampleCount, EMPTY_SAMPLE_COUNT } from "@/lib/sampleCount";

export const dynamic = "force-dynamic";

interface SearchParams {
  window?: string;
}

// The Overview is fixed to the high-signal defaults; deeper slicing (region,
// infra, connection mode, method) lives on /performance. The leaderboard ranks
// the Overall (all-active-geo) blend, cold getTransaction, default weights —
// users re-weight via the workload-persona presets client-side.
const OVERVIEW_METHOD: Method = "getTransaction";
const OVERVIEW_MODE = "cold" as const;
// Geos + methods surfaced in each expanded row's latency grid (our two
// best-covered geos × the high-signal core methods).
const GRID_GEOS: readonly GeoRegion[] = ["na-east", "eu-central"];
const GRID_METHODS: readonly Method[] = [
  "getTransaction",
  "getAccountInfo",
  "getTokenAccountsByOwner",
];

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const windowHours = WINDOWS.some((w) => w.value === parseInt(params.window ?? "", 10))
    ? parseInt(params.window!, 10)
    : 24;

  let perGeo: { geo: GeoRegion; rows: Awaited<ReturnType<typeof fetchAggregatesForGeo>>; eligible: Awaited<ReturnType<typeof fetchAggregatesForGeo>> }[] = [];
  let methodRegionLatency: MethodRegionLatency = {};
  let sampleCount = EMPTY_SAMPLE_COUNT;
  let error: string | null = null;

  try {
    const activeGeos = await fetchActiveGeos();

    // Leaderboard ranking: per-active-geo getTransaction/cold aggregates, blended
    // Overall client-side. Plus the expanded-row latency grid: the two showcase
    // geos × the core methods (cold). getTransaction × {na-east, eu-central}
    // overlaps the leaderboard fetches' cache keys, so it's not double work.
    const [perGeoRaw, gridRaw, sampleData] = await Promise.all([
      Promise.all(
        activeGeos.map(async (g) => {
          const rows = await fetchAggregatesForGeo({
            geoRegion: g,
            windowHours,
            connectionMode: OVERVIEW_MODE,
            method: OVERVIEW_METHOD,
          });
          const eligible = rows.filter(
            (r) => r.eligible === true && r.p95_ms !== null && r.p50_ms !== null,
          );
          return { geo: g, rows, eligible };
        }),
      ),
      Promise.all(
        GRID_GEOS.flatMap((g) =>
          GRID_METHODS.map(async (m) => {
            const rows = await fetchAggregatesForGeo({
              geoRegion: g,
              windowHours,
              connectionMode: OVERVIEW_MODE,
              method: m,
            });
            return { geo: g, method: m, rows };
          }),
        ),
      ),
      fetchSampleCount(),
    ]);

    perGeo = perGeoRaw;
    sampleCount = sampleData;

    const mrl: MethodRegionLatency = {};
    for (const { geo, method, rows } of gridRaw) {
      for (const r of rows) {
        ((mrl[r.provider_id] ??= {})[method] ??= {})[geo] = { p50: r.p50_ms, p95: r.p95_ms };
      }
    }
    methodRegionLatency = mrl;
  } catch (err) {
    error = (err as Error).message;
  }

  const methodCount = ALL_METHODS.length;

  return (
    <div>
      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, marginBottom: 16 }}>
          DB error: {error}
        </div>
      )}

      {/* Intro + weight radar + preset chips + leaderboard. */}
      <OverviewBoard
        rawPerGeo={perGeo}
        methodRegionLatency={methodRegionLatency}
        sampleCount={sampleCount}
        methodCount={methodCount}
      />

      {/* Deep-dive CTA into /performance. */}
      <section className="mt-6 flex justify-end">
        <Link
          href={"/performance" as Route}
          className="group inline-flex items-center gap-2 rounded-full border border-accent/40 px-4 py-[8px] text-[13px] font-medium text-accent transition-colors hover:bg-accent/10 hover:border-accent hover:no-underline"
        >
          Full performance details
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          >
            <path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      </section>
    </div>
  );
}
