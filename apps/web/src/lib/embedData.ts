/**
 * Server-side data assembly shared by the full-page dashboard routes and the
 * chromeless /embed/* widget routes, so the two never drift.
 *
 * Scope: the *server-assembled inputs* to the client wrapper components only.
 * The wrappers' client tuning state (component/region/method weights, selected
 * methods) lives inside <OverviewBoard>/<MethodRegionTabs> and is intentionally
 * NOT here — the embeds are preset-driven and reuse that same in-component
 * blending, so a leaderboard embed and a score embed built off the same cube
 * always agree.
 *
 * These helpers do the raw fetch + shape work and let errors propagate; callers
 * wrap in try/catch (dashboard pages → inline banner; embed pages → error.tsx).
 */

import { GEO_REGIONS } from "@rpcbench/shared";
import { ALL_METHODS } from "./methods";
import {
  buildMethodGeoCube,
  fetchActiveGeos,
  fetchMethodLatency,
  fetchMethodGeoLatency,
  withProviderFallback,
  type MethodLatencyRow,
} from "./leaderboard";
import { fetchSampleCount, type SampleCount } from "./sampleCount";
import { type MethodGeoRows } from "@/components/leaderboardShared";
import { type MethodRegionLatency } from "@/components/IndexLeaderboard";
import {
  type BreakdownRow,
  type CubeRow,
  type InfraTableData,
} from "@/components/MethodRegionTabs";

/** The overview mode is always cold — matches the home board and its share card. */
export const OVERVIEW_MODE = "cold" as const;

export interface OverviewBoardData {
  cube: MethodGeoRows[];
  methodRegionLatency: MethodRegionLatency;
  sampleCount: SampleCount;
  methodCount: number;
  /** Providers the live window couldn't rank, shown from their own most recent
   *  window that could: provider id → ISO end of that window. A provider not in
   *  the map is live. */
  providerAsOf: Record<string, string>;
}

/**
 * The five-prop <OverviewBoard> feed minus presetId (the caller supplies that):
 * the per-(method, geo) cube over ALL methods + active geos, the
 * provider→method→geo latency map for the expandable grid, the live sample
 * count, and the total method count. One multi-method query per geo (≤6), not
 * one per method — the cube carries every method because any can be toggled in
 * client-side.
 *
 * Providers the live window can't rank come from their own most recent window
 * that does (withProviderFallback), listed in `providerAsOf`.
 */
export async function buildOverviewBoardData(windowHours: number): Promise<OverviewBoardData> {
  const activeGeos = await fetchActiveGeos();
  const targets = activeGeos.length > 0 ? activeGeos : [...GEO_REGIONS];

  const [{ cube, providerAsOf }, sampleCount] = await Promise.all([
    withProviderFallback({
      windowHours,
      connectionMode: OVERVIEW_MODE,
      label: "buildOverviewBoardData",
      build: (w) =>
        buildMethodGeoCube({ geos: targets, methods: ALL_METHODS, connectionMode: OVERVIEW_MODE, w }),
    }),
    fetchSampleCount(),
  ]);

  const methodRegionLatency: MethodRegionLatency = {};
  for (const { method, geo, rows } of cube) {
    for (const r of rows) {
      ((methodRegionLatency[r.provider_id] ??= {})[method] ??= {})[geo] = {
        p50: r.p50_ms,
        p95: r.p95_ms,
      };
    }
  }

  return { cube, methodRegionLatency, sampleCount, methodCount: ALL_METHODS.length, providerAsOf };
}

/**
 * The <MethodRegionTabs> `byInfra` feed: for each infra key ("all" + each active
 * worker_provider) the per-method p50/p95 rows (cold+warm) and the raw
 * method×geo cube rows for the expandable region drill-down. Pre-fetches every
 * infra so the table's Infra dropdown switches client-side.
 */
export async function buildLatencyTableData({
  infraKeys,
  windowHours,
  tableProviders,
}: {
  infraKeys: string[];
  windowHours: number;
  tableProviders: { id: string; name: string }[];
}): Promise<Record<string, InfraTableData>> {
  const [mlByInfra, mglByInfra] = await Promise.all([
    Promise.all(
      infraKeys.map((k) =>
        fetchMethodLatency({ windowHours, ...(k !== "all" ? { workerProvider: k } : {}) }),
      ),
    ),
    Promise.all(
      infraKeys.map((k) =>
        fetchMethodGeoLatency({ windowHours, ...(k !== "all" ? { workerProvider: k } : {}) }),
      ),
    ),
  ]);

  const buildMethodRows = (ml: MethodLatencyRow[]): BreakdownRow[] =>
    [...ALL_METHODS]
      .sort((a, b) => a.localeCompare(b))
      .map((m) => ({
        key: m,
        label: m,
        isCode: true,
        values: Object.fromEntries(
          tableProviders.map((p) => {
            const cold = ml.find(
              (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "cold",
            );
            const warm = ml.find(
              (r) => r.method === m && r.provider_id === p.id && r.connection_mode === "warm",
            );
            return [
              p.id,
              {
                cold: { p50: cold?.p50 ?? null, p95: cold?.p95 ?? null },
                warm: { p50: warm?.p50 ?? null, p95: warm?.p95 ?? null },
              },
            ];
          }),
        ),
      }));

  const byInfra: Record<string, InfraTableData> = {};
  infraKeys.forEach((key, i) => {
    byInfra[key] = {
      methodRows: buildMethodRows(mlByInfra[i] ?? []),
      cubeRows: (mglByInfra[i] ?? []) as CubeRow[],
    };
  });
  return byInfra;
}
