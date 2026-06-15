import Link from "next/link";
import type { Route } from "next";
import {
  type GeoRegion,
  type Method,
} from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOWS } from "@/lib/windows";
import { type MethodRegionLatency } from "@/components/IndexLeaderboard";
import { type MethodOption } from "@/components/MethodFilter";
import { OverviewBoard } from "@/components/OverviewBoard";
import { fetchActiveGeos, fetchAggregatesForGeo } from "@/lib/leaderboard";
import { fetchSampleCount, EMPTY_SAMPLE_COUNT } from "@/lib/sampleCount";
import { DB_ERROR_MESSAGE } from "@/lib/db";

export const dynamic = "force-dynamic";

interface SearchParams {
  window?: string;
  method?: string;
}

// Build an Overview URL preserving the current params with `override` applied
// (null clears a key). Used to make the method dropdown navigate in place.
function urlWith(
  params: SearchParams,
  override: Partial<Record<keyof SearchParams, string | null>>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v != null) merged[k] = String(v);
  for (const [k, v] of Object.entries(override)) {
    if (v === null) delete merged[k];
    else if (v != null) merged[k] = String(v);
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/?${qs}` : "/";
}

// The Overview is fixed to high-signal defaults (Overall all-active-geo blend,
// cold start, default weights); deeper slicing (region, infra, connection mode)
// lives on /performance. The ranked method is switchable via ?method= and
// defaults to getTransaction; users re-weight via the persona presets / weight
// sliders client-side.
const DEFAULT_METHOD: Method = "getTransaction";
const OVERVIEW_MODE = "cold" as const;
// Geos + methods surfaced in each expanded row's latency grid. All six
// benchmarked regions × the high-signal core methods — the expanded row shows
// two geos at a time and a chevron cycles through the rest (see GEO_PAIRS).
const GRID_GEOS: readonly GeoRegion[] = [
  "na-east",
  "eu-central",
  "ap-northeast",
  "na-west",
  "eu-west",
  "ap-southeast",
];
// High-signal core methods always shown in the expanded-row grid. The ranked
// method is prepended to these at request time (see gridMethods below).
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

  // Ranked method — validated against the canonical set, defaulting to
  // getTransaction. Drives the leaderboard fetch below.
  const methodRaw = params.method ?? DEFAULT_METHOD;
  const selectedMethod: Method = (ALL_METHODS as readonly string[]).includes(methodRaw)
    ? (methodRaw as Method)
    : DEFAULT_METHOD;

  // Expanded-row grid: the ranked method first, then the high-signal core
  // methods (de-duped) so the drill-down always includes what the board ranks by.
  const gridMethods: Method[] = [
    selectedMethod,
    ...GRID_METHODS.filter((m) => m !== selectedMethod),
  ];

  // Alphabetically-sorted options for the inline method dropdown.
  const methodOptions: MethodOption[] = [...ALL_METHODS]
    .sort((a, b) => a.localeCompare(b))
    .map((m) => ({ method: m, href: urlWith(params, { method: m }) }));

  let perGeo: { geo: GeoRegion; rows: Awaited<ReturnType<typeof fetchAggregatesForGeo>>; eligible: Awaited<ReturnType<typeof fetchAggregatesForGeo>> }[] = [];
  let methodRegionLatency: MethodRegionLatency = {};
  let sampleCount = EMPTY_SAMPLE_COUNT;
  let error: string | null = null;

  try {
    const activeGeos = await fetchActiveGeos();

    // Leaderboard ranking: per-active-geo selectedMethod/cold aggregates, blended
    // Overall client-side. Plus the expanded-row latency grid: all six geos ×
    // gridMethods (cold). The selectedMethod × each active geo overlaps the
    // leaderboard fetches' cache keys, so those calls aren't double work.
    const [perGeoRaw, gridRaw, sampleData] = await Promise.all([
      Promise.all(
        activeGeos.map(async (g) => {
          const rows = await fetchAggregatesForGeo({
            geoRegion: g,
            windowHours,
            connectionMode: OVERVIEW_MODE,
            method: selectedMethod,
          });
          const eligible = rows.filter(
            (r) => r.eligible === true && r.p95_ms !== null && r.p50_ms !== null,
          );
          return { geo: g, rows, eligible };
        }),
      ),
      Promise.all(
        GRID_GEOS.flatMap((g) =>
          gridMethods.map(async (m) => {
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
    console.error("[/]", err);
    error = DB_ERROR_MESSAGE;
  }

  const methodCount = ALL_METHODS.length;

  return (
    <div>
      {error && (
        <div className="badge bad" style={{ display: "block", padding: 12, marginBottom: 16 }}>
          DB error: {error}
        </div>
      )}

      {/* Intro + weights panel + preset chips + leaderboard. */}
      <OverviewBoard
        rawPerGeo={perGeo}
        methodRegionLatency={methodRegionLatency}
        sampleCount={sampleCount}
        methodCount={methodCount}
        selectedMethod={selectedMethod}
        methodOptions={methodOptions}
        gridMethods={gridMethods}
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
