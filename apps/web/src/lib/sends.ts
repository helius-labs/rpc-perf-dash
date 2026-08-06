/**
 * Send-board data layer. Reads the `send_leaderboard_agg` precompute (written by
 * the generator's send rollups), aggregates per send target across scenarios +
 * geos, and scores with the parallel send scorer. Mirrors `leaderboard.ts`'s
 * `unstable_cache` + `db()` pattern.
 */

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import {
  DEFAULT_SEND_WEIGHTS,
  scoreSends,
  type SendScoringWeights,
  type SendTargetMetrics,
} from "@rpcbench/shared/sendScoring";
import { SEND_METHODOLOGY_VERSION, GEO_REGIONS, type GeoRegion } from "@rpcbench/shared";
import { WORKER_PROVIDER_LABELS } from "@rpcbench/shared/providers";
import { scenarioLabel, targetLabel } from "@/lib/sendLabels";
import { db } from "@/lib/db";
import type { ChartSeries } from "@/lib/chartData";
import type { ScoreSeries } from "@/lib/leaderboard";

const CACHE_TTL_S = 120;

export interface SendBoardRow {
  rank: number;
  send_target: string;
  scenario: string | null;
  total: number;
  reliability: number;
  latency: number;
  landing_rate: number;
  slot_latency_p50: number | null;
  slot_latency_p95: number | null;
  priority_fee_avg: number | null;
  /** Estimated lamports paid per tx: base fee + priority (fee µlpc × CU). Tip
   *  not yet in the rollup — add tip_avg for full cost. */
  cost_lamports: number | null;
  sample_count_total: number;
  /** Outcome breakdown (from send_rollups) — powers the "why not 100%?" tooltip
   *  + the expanded row. landed + reverted are the landing-rate numerator. */
  outcomes: {
    landed: number;
    reverted: number;
    not_landed: number;
    submit_error: number;
  };
  /** Per-geo metrics for the client-side region blend (region selector). Keyed
   *  by geo; each carries the axes scoreSends needs. */
  per_geo: Record<string, SendGeoMetrics>;
}

/** The scoreable metrics for one (target, geo) — the region-blend inputs. */
export interface SendGeoMetrics {
  landing_rate: number;
  slot_latency_p50: number | null;
  slot_latency_p95: number | null;
}

/** Base transaction fee per signature (lamports) — same for all targets. */
const BASE_FEE_LAMPORTS = 5_000;

interface AggRow {
  send_target: string;
  scenario: string;
  geo: string;
  sample_count_total: number;
  landing_rate: number | null;
  slot_latency_p50: number | null;
  slot_latency_p95: number | null;
  priority_fee_avg: string | null;
  cu_requested_avg: number | null;
}

/**
 * Fetch + score the send board for a grain, optionally filtered to one scenario.
 * Aggregates each target over its most-recent window across geos.
 */
export const fetchSendBoard = unstable_cache(
  async (grain: "1h" | "1d" = "1d", scenario?: string): Promise<SendBoardRow[]> => {
    const rows = (await db().execute(sql`
      WITH latest AS (
        SELECT max(window_start) AS w
        FROM send_leaderboard_agg
        WHERE grain = ${grain} AND methodology_version = ${SEND_METHODOLOGY_VERSION}
      )
      SELECT
        send_target, scenario, geo,
        sum(sample_count_total)::int AS sample_count_total,
        avg(landing_rate)::float AS landing_rate,
        avg(slot_latency_p50)::float AS slot_latency_p50,
        avg(slot_latency_p95)::float AS slot_latency_p95,
        avg(priority_fee_avg)::bigint AS priority_fee_avg,
        avg(cu_requested_avg)::float AS cu_requested_avg
      FROM send_leaderboard_agg, latest
      WHERE grain = ${grain}
        AND methodology_version = ${SEND_METHODOLOGY_VERSION}
        AND window_start = latest.w
        ${scenario ? sql`AND scenario = ${scenario}` : sql``}
      GROUP BY send_target, scenario, geo
    `)) as unknown as AggRow[];

    // Outcome breakdown (per target) from send_rollups — send_leaderboard_agg
    // doesn't carry the per-outcome counts, so pull them here for the "why not
    // 100%?" tooltip + the expanded row.
    const countRows = (await db().execute(sql`
      WITH latest AS (
        SELECT max(window_start) AS w
        FROM send_rollups
        WHERE grain = ${grain} AND methodology_version = ${SEND_METHODOLOGY_VERSION}
      )
      SELECT send_target,
             sum(landed_count)::int AS landed,
             sum(reverted_count)::int AS reverted,
             sum(not_landed_count)::int AS not_landed,
             sum(submit_error_count)::int AS submit_error
      FROM send_rollups, latest
      WHERE grain = ${grain}
        AND methodology_version = ${SEND_METHODOLOGY_VERSION}
        AND window_start = latest.w
        ${scenario ? sql`AND scenario = ${scenario}` : sql``}
      GROUP BY send_target
    `)) as unknown as {
      send_target: string;
      landed: number;
      reverted: number;
      not_landed: number;
      submit_error: number;
    }[];
    const countsByTarget = new Map<string, SendBoardRow["outcomes"]>();
    for (const c of countRows) {
      countsByTarget.set(c.send_target, {
        landed: c.landed ?? 0,
        reverted: c.reverted ?? 0,
        not_landed: c.not_landed ?? 0,
        submit_error: c.submit_error ?? 0,
      });
    }

    // Aggregate per send_target across scenarios (simple mean of the axes).
    const byTarget = new Map<string, AggRow[]>();
    for (const r of rows) {
      const list = byTarget.get(r.send_target) ?? [];
      list.push(r);
      byTarget.set(r.send_target, list);
    }

    const metrics: SendTargetMetrics[] = [];
    const extras = new Map<string, Omit<SendBoardRow, "rank" | "total" | "reliability" | "latency">>();
    for (const [target, list] of byTarget) {
      // Mean over NON-NULL rows. slot_latency_p50/p95 come out NULL for any
      // (geo, scenario) bucket where nothing landed (percentile over an empty
      // set); counting those as 0 would score them as 0-slot latency — best
      // possible — and that credit is anticorrelated with landing (a bucket that
      // landed nothing would earn perfect latency). Filter, don't zero.
      const avg = (f: (r: AggRow) => number | null): number | null => {
        const vals = list.map(f).filter((v): v is number => v != null);
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      // landing_rate is present whenever a row exists (0 for a no-land bucket), so
      // its all-null case only means "no rows" → 0. slot p50/p95 stay null when
      // nothing landed, so the scorer gives no latency credit (not 0 slots = best).
      const landing = avg((r) => r.landing_rate) ?? 0;
      const l50 = avg((r) => r.slot_latency_p50);
      const l95 = avg((r) => r.slot_latency_p95);
      // Cost per tx = base fee + priority (µlamports/CU × CU-limit ÷ 1e6). Compute
      // it PER ROW then average — `list` spans scenarios with different CU limits
      // AND different adaptive fees (the fee controller is per-scenario), so
      // pairing one scenario's fee with the cross-scenario mean CU would
      // misattribute the cost. Uses the CU *limit* (cu_requested — what Solana
      // charges the priority fee on; cu_used isn't available from the polling
      // confirm). ⚠️ Excludes tips: this is the full per-tx cost ONLY while no
      // SEND_TARGET_CONFIGS entry sets a tip. tip_amount IS written to
      // landing_tx_results but is NOT rolled up, so adding a tipped relay would
      // silently understate this cost (and break "Cost has no winner") with no
      // error — roll tip into the rollup + this formula if that changes.
      const rowCost = (r: AggRow): number | null => {
        const fee = r.priority_fee_avg != null ? Number(r.priority_fee_avg) : null;
        return fee != null && r.cu_requested_avg != null && r.cu_requested_avg > 0
          ? BASE_FEE_LAMPORTS + (fee * r.cu_requested_avg) / 1_000_000
          : null;
      };
      const costList = list.map(rowCost).filter((v): v is number => v != null);
      const cost = costList.length
        ? Math.round(costList.reduce((s, v) => s + v, 0) / costList.length)
        : null;
      // Display fee = mean priority fee across the target's rows, filtering nulls
      // (avg() counts null rows as 0 and understates it — same fix as cost above).
      const fees = list
        .map((r) => (r.priority_fee_avg != null ? Number(r.priority_fee_avg) : null))
        .filter((v): v is number => v != null);
      const feeMicro = fees.length ? fees.reduce((s, v) => s + v, 0) / fees.length : null;
      metrics.push({
        send_target: target,
        landing_rate: landing,
        slot_latency_p50: l50,
        slot_latency_p95: l95,
      });
      // Per-geo metrics (mean across scenarios within each geo) for the region blend.
      const byGeo = new Map<string, AggRow[]>();
      for (const row of list) {
        const g = byGeo.get(row.geo) ?? [];
        g.push(row);
        byGeo.set(row.geo, g);
      }
      const per_geo: Record<string, SendGeoMetrics> = {};
      for (const [geo, glist] of byGeo) {
        const gavg = (f: (r: AggRow) => number | null): number | null => {
          const vals = glist.map(f).filter((v): v is number => v != null);
          return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
        };
        per_geo[geo] = {
          landing_rate: gavg((r) => r.landing_rate) ?? 0,
          slot_latency_p50: gavg((r) => r.slot_latency_p50),
          slot_latency_p95: gavg((r) => r.slot_latency_p95),
        };
      }
      extras.set(target, {
        send_target: target,
        scenario: scenario ?? null,
        landing_rate: landing,
        slot_latency_p50: l50,
        slot_latency_p95: l95,
        priority_fee_avg: feeMicro,
        cost_lamports: cost,
        sample_count_total: list.reduce((s, r) => s + r.sample_count_total, 0),
        outcomes: countsByTarget.get(target) ?? { landed: 0, reverted: 0, not_landed: 0, submit_error: 0 },
        per_geo,
      });
    }

    const scored = scoreSends(metrics);
    scored.sort((a, b) => b.total - a.total);
    return scored.map((s, i) => {
      const e = extras.get(s.send_target)!;
      return {
        rank: i + 1,
        send_target: s.send_target,
        scenario: e.scenario,
        total: s.total,
        reliability: s.reliability,
        latency: s.latency,
        landing_rate: e.landing_rate,
        slot_latency_p50: e.slot_latency_p50,
        slot_latency_p95: e.slot_latency_p95,
        priority_fee_avg: e.priority_fee_avg,
        cost_lamports: e.cost_lamports,
        sample_count_total: e.sample_count_total,
        outcomes: e.outcomes,
        per_geo: e.per_geo,
      };
    });
  },
  ["send-board"],
  { revalidate: CACHE_TTL_S },
);

export { DEFAULT_SEND_WEIGHTS };
export type { SendScoringWeights };

/**
 * Time series shaped for the SAME `LatencyChart` component the read board uses,
 * so the chart is byte-for-byte identical (tooltip, crosshair, bins, toggles) —
 * only the data differs. `series` (Latency metric) = wall latency ms per target;
 * `scoreSeries` (Score metric) = landing rate 0–100 per target.
 */
export const fetchSendChart = unstable_cache(
  async (
    grain: "1h" | "1d" = "1h",
    windowHours = 48,
  ): Promise<{ series: ChartSeries[]; scoreSeries: ScoreSeries[] }> => {
    const rows = (await db().execute(sql`
      SELECT send_target, window_start,
             avg(wall_latency_p50)::float AS p50,
             avg(wall_latency_p95)::float AS p95,
             avg(landing_rate)::float AS landing
      FROM send_rollups
      WHERE grain = ${grain}
        AND methodology_version = ${SEND_METHODOLOGY_VERSION}
        AND window_start >= now() - (${String(windowHours)} || ' hours')::interval
      GROUP BY send_target, window_start
      ORDER BY window_start ASC
    `)) as unknown as {
      send_target: string;
      window_start: string | Date;
      p50: number | null;
      p95: number | null;
      landing: number | null;
    }[];

    const lat = new Map<string, ChartSeries["points"]>();
    const score = new Map<string, ScoreSeries["points"]>();
    for (const r of rows) {
      const t = r.window_start instanceof Date ? r.window_start : new Date(r.window_start);
      if (r.p50 != null && r.p95 != null) {
        const pts = lat.get(r.send_target) ?? [];
        pts.push({ t, p50_ms: Math.round(r.p50), p95_ms: Math.round(r.p95) });
        lat.set(r.send_target, pts);
      }
      if (r.landing != null) {
        const pts = score.get(r.send_target) ?? [];
        pts.push({ t, score: r.landing * 100 });
        score.set(r.send_target, pts);
      }
    }
    return {
      series: [...lat.entries()].map(([provider_id, points]) => ({ provider_id, points })),
      scoreSeries: [...score.entries()].map(([provider_id, points]) => ({ provider_id, points })),
    };
  },
  ["send-chart"],
  { revalidate: CACHE_TTL_S },
);

/**
 * The send-board row for one target id (or null if it has no send data). Used by
 * the provider page to show that provider's transaction-send performance.
 */
export async function fetchSendSummary(id: string): Promise<SendBoardRow | null> {
  const board = await fetchSendBoard("1d");
  return board.find((r) => r.send_target === id) ?? null;
}

// ── Time series (charts) ───────────────────────────────────────────────────

export interface SendSeriesPoint {
  /** Bucket start, epoch ms. */
  t: number;
  landing_rate: number | null;
  slot_latency_p50: number | null;
  priority_fee_avg: number | null;
}
export interface SendSeries {
  send_target: string;
  points: SendSeriesPoint[];
}

/**
 * Per-target time series over the rollup buckets — landing rate, slot latency,
 * and the in-effect adaptive fee. Reads send_rollups (1h/1d) blended across
 * geos + scenarios per bucket, so the /sends chart plots exactly like the read
 * board's latency/score-over-time chart.
 */
export const fetchSendSeries = unstable_cache(
  async (grain: "1h" | "1d" = "1h", windowHours = 48): Promise<SendSeries[]> => {
    const rows = (await db().execute(sql`
      SELECT send_target,
             extract(epoch FROM window_start) * 1000 AS t,
             avg(landing_rate)::float AS landing_rate,
             avg(slot_latency_p50)::float AS slot_latency_p50,
             avg(priority_fee_avg)::float AS priority_fee_avg
      FROM send_rollups
      WHERE grain = ${grain}
        AND methodology_version = ${SEND_METHODOLOGY_VERSION}
        AND window_start >= now() - (${String(windowHours)} || ' hours')::interval
      GROUP BY send_target, window_start
      ORDER BY window_start ASC
    `)) as unknown as {
      send_target: string;
      t: number;
      landing_rate: number | null;
      slot_latency_p50: number | null;
      priority_fee_avg: number | null;
    }[];

    const byTarget = new Map<string, SendSeriesPoint[]>();
    for (const r of rows) {
      const pts = byTarget.get(r.send_target) ?? [];
      pts.push({
        t: Number(r.t),
        landing_rate: r.landing_rate,
        slot_latency_p50: r.slot_latency_p50,
        priority_fee_avg: r.priority_fee_avg,
      });
      byTarget.set(r.send_target, pts);
    }
    return [...byTarget.entries()].map(([send_target, points]) => ({ send_target, points }));
  },
  ["send-series"],
  { revalidate: CACHE_TTL_S },
);

// ── Scenario × region × target table (mirrors the RPC latency table) ─────────
//
// Unlike fetchSendBoard (which collapses everything to one row per target), this
// preserves the full send_leaderboard_agg cube — scenario (rows) × send_target
// (columns) × geo (region drill-down) × worker_provider (infra dropdown) — and
// every per-cell metric (landing rate, slot p50/p95, wall p50/p95,
// cost). It feeds <SendMethodRegionTabs>, the sends analogue of the RPC
// MethodRegionTabs. Aggregation across a collapsed dimension is a simple mean of
// the present (non-null) values, matching the read latency table's per-geo blend.

/** Per-cell metrics for one (scenario|geo) × send_target intersection. */
export interface SendCellValue {
  /** Landing rate 0..1 (higher is better). */
  landing: number | null;
  /** Slot latency percentiles (lower is better). */
  slot: { p50: number | null; p95: number | null };
  /** Wall latency ms percentiles (lower is better). */
  wall: { p50: number | null; p95: number | null };
  /** Estimated lamports/tx = base fee + priority (µlpc × CU) (lower is better). */
  cost: number | null;
  samples: number;
}
export interface SendBreakdownRow {
  key: string;
  label: string;
  /** Render the row label as <code> (scenario ids) vs plain text (region names). */
  isCode?: boolean;
  /** Keyed by send_target id. */
  values: Record<string, SendCellValue>;
}
/** Flat (geo × scenario × send_target) cube row powering the region drill-down. */
export interface SendCubeRow {
  geo: GeoRegion;
  scenario: string;
  send_target: string;
  cell: SendCellValue;
}
export interface SendInfraTableData {
  scenarioRows: SendBreakdownRow[];
  cubeRows: SendCubeRow[];
}
export interface SendTableData {
  byInfra: Record<string, SendInfraTableData>;
  infraOptions: { id: string; label: string }[];
  targets: { id: string; name: string }[];
}

interface SendAggRawRow {
  geo: string;
  worker_provider: string;
  send_target: string;
  scenario: string;
  sample_count_total: number;
  landing_rate: number | null;
  slot_latency_p50: number | null;
  slot_latency_p95: number | null;
  wall_latency_p50: number | null;
  wall_latency_p95: number | null;
  cu_requested_avg: number | null;
  priority_fee_avg: string | null;
}

/** Mean of the present (non-null) values, or null if none present. */
function meanOrNull(vals: (number | null)[]): number | null {
  const present = vals.filter((v): v is number => v != null);
  return present.length ? present.reduce((s, v) => s + v, 0) / present.length : null;
}

/** Collapse a set of raw rows (over geo and/or worker_provider) into one cell. */
function aggregateCell(rows: SendAggRawRow[]): SendCellValue {
  const feeMicro = meanOrNull(rows.map((r) => (r.priority_fee_avg != null ? Number(r.priority_fee_avg) : null)));
  const cu = meanOrNull(rows.map((r) => r.cu_requested_avg));
  const cost =
    feeMicro != null && cu != null && cu > 0
      ? Math.round(BASE_FEE_LAMPORTS + (feeMicro * cu) / 1_000_000)
      : null;
  return {
    landing: meanOrNull(rows.map((r) => r.landing_rate)),
    slot: {
      p50: meanOrNull(rows.map((r) => r.slot_latency_p50)),
      p95: meanOrNull(rows.map((r) => r.slot_latency_p95)),
    },
    wall: {
      p50: meanOrNull(rows.map((r) => r.wall_latency_p50)),
      p95: meanOrNull(rows.map((r) => r.wall_latency_p95)),
    },
    cost,
    samples: rows.reduce((s, r) => s + r.sample_count_total, 0),
  };
}


/**
 * Build the per-infra scenario × region × target cube for the sends latency
 * table. One query over send_leaderboard_agg at the latest window; the "all"
 * infra pools across clouds, and one entry per active worker_provider lets the
 * table's Infra dropdown switch client-side (same shape as buildLatencyTableData).
 */
export const fetchSendTableData = unstable_cache(
  async (grain: "1h" | "1d" = "1d"): Promise<SendTableData> => {
    const raw = (await db().execute(sql`
      WITH latest AS (
        SELECT max(window_start) AS w
        FROM send_leaderboard_agg
        WHERE grain = ${grain} AND methodology_version = ${SEND_METHODOLOGY_VERSION}
      )
      SELECT geo, worker_provider, send_target, scenario,
             sample_count_total, landing_rate,
             slot_latency_p50, slot_latency_p95,
             wall_latency_p50, wall_latency_p95,
             cu_requested_avg, priority_fee_avg
      FROM send_leaderboard_agg, latest
      WHERE grain = ${grain}
        AND methodology_version = ${SEND_METHODOLOGY_VERSION}
        AND window_start = latest.w
    `)) as unknown as SendAggRawRow[];

    const geoSet = new Set<string>(GEO_REGIONS);
    const rows = raw.filter((r) => geoSet.has(r.geo));

    const wps = [...new Set(rows.map((r) => r.worker_provider))].sort();
    const infraKeys = ["all", ...wps];
    const targetIds = [...new Set(rows.map((r) => r.send_target))];
    const scenarios = [...new Set(rows.map((r) => r.scenario))].sort();

    const build = (subset: SendAggRawRow[]): SendInfraTableData => {
      // scenarioRows: one row per scenario; cell = collapse over geo per target.
      const scenarioRows: SendBreakdownRow[] = scenarios.map((scenario) => {
        const values: Record<string, SendCellValue> = {};
        for (const target of targetIds) {
          const cellRows = subset.filter((r) => r.scenario === scenario && r.send_target === target);
          if (cellRows.length) values[target] = aggregateCell(cellRows);
        }
        return { key: scenario, label: scenarioLabel(scenario), isCode: false, values };
      });
      // cubeRows: one per (geo, scenario, target); cell = collapse over wp only.
      const cubeRows: SendCubeRow[] = [];
      for (const geo of GEO_REGIONS) {
        for (const scenario of scenarios) {
          for (const target of targetIds) {
            const cellRows = subset.filter(
              (r) => r.geo === geo && r.scenario === scenario && r.send_target === target,
            );
            if (cellRows.length) {
              cubeRows.push({ geo, scenario, send_target: target, cell: aggregateCell(cellRows) });
            }
          }
        }
      }
      return { scenarioRows, cubeRows };
    };

    const byInfra: Record<string, SendInfraTableData> = { all: build(rows) };
    for (const wp of wps) byInfra[wp] = build(rows.filter((r) => r.worker_provider === wp));

    return {
      byInfra,
      infraOptions: [
        { id: "all", label: "All infra" },
        ...wps.map((wp) => ({ id: wp, label: WORKER_PROVIDER_LABELS[wp] ?? wp })),
      ],
      targets: targetIds
        .map((id) => ({ id, name: targetLabel(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
  ["send-table"],
  { revalidate: CACHE_TTL_S },
);
