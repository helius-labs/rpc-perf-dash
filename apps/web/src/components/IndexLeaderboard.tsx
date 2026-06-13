"use client";

/**
 * IndexLeaderboard — the "Index, dark" typographic ranked list from the Claude
 * Design handoff. No cards: bold ranked type with #1 dominating by scale, an
 * arrow per row linking to the provider deep-dive, and a click-to-expand inline
 * stat strip (p50 / p95 / p99 / win rate / samples / success) under each row.
 * All rows start expanded so the full field fits in roughly one viewport.
 *
 * Scoring runs client-side: the server hands us raw per-geo aggregates, we
 * score them with the default weights.
 * Weight sliders / region weights were dropped from the home page; the formula
 * still uses DEFAULT_WEIGHTS / DEFAULT_REGION_WEIGHTS so rankings match the
 * documented methodology.
 */

import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  DEFAULT_REGION_WEIGHTS,
  blendRegionScores,
  type ScoredProvider,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { GEO_REGIONS, GEO_REGION_LABELS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import { slugForProviderId } from "@rpcbench/shared/providers";
import { brandColorFor } from "@/lib/providerColors";
import { ALL_METHODS } from "@/lib/methods";
import { Tooltip } from "./Tooltip";
import {
  FailureBreakdownList,
  RegionBlendBreakdown,
  ScoreFormula,
  SubScoreBreakdown,
  buildOverallLeaderRows,
  buildSingleLeaderRows,
  scoreColor,
  scorePerGeo,
  type FailureBreakdownEntry,
  type RowAgg,
} from "./leaderboardShared";

/** L/W/R/C/F sub-scores for the score-breakdown tooltip (region view). */
interface ScoreSubs {
  latency_sub: number;
  win_sub: number;
  reliability_sub: number;
  correctness_sub: number;
  freshness_sub: number;
  total: number;
}

export interface RawGeoOutcome {
  geo: GeoRegion;
  rows: RowAgg[];
  eligible: RowAgg[];
}

/** p50/p95 latency for one (provider × method × geo) cell in the expanded row. */
export interface LatencyCell {
  p50: number | null;
  p95: number | null;
}

/**
 * provider id → method → geo → latency. Assembled server-side (page.tsx) for
 * the expanded-row method×region grid. Only the OVERVIEW_METHODS × OVERVIEW_GEOS
 * cells are populated.
 */
export type MethodRegionLatency = Record<string, Record<string, Record<string, LatencyCell>>>;

/** Methods surfaced in the expanded-row latency grid (the high-signal core). */
const OVERVIEW_METHODS: ReadonlyArray<Method> = [
  "getTransaction",
  "getAccountInfo",
  "getTokenAccountsByOwner",
];

/** Geos surfaced in the expanded-row latency grid — our two best-covered. */
const OVERVIEW_GEOS: ReadonlyArray<GeoRegion> = ["na-east", "eu-central"];

interface IndexRow {
  id: string;
  name: string;
  score: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  winRate: number;
  samples: number;
  success: number;
  // Failed-call count + per-category breakdown behind the missing success %.
  failed: number;
  failure_breakdown: FailureBreakdownEntry[];
  // Score-breakdown tooltip data. Single-geo view: the L/W/R/C/F sub-scores
  // (`subs`). Overall view: the per-region blend (`regionBlend`). Exactly one
  // is populated per the active view.
  subs: ScoreSubs | null;
  regionBlend: Array<{ label: string; weight: number; score: number }> | null;
}

function fmtMs(v: number | null): React.ReactNode {
  return v == null ? "—" : <>{Math.round(v)}<i>ms</i></>;
}

/**
 * One leaderboard row. Memoized so expanding/collapsing a sibling row (which
 * flips the parent's `open` Set) doesn't re-render — and re-build the
 * method×region table of — every other row. Only the toggled row's `isOpen`
 * changes, so React.memo skips the rest. Props are kept referentially stable by
 * the parent: `row` comes from the `ordered` useMemo, `toggle` is useCallback'd,
 * `weights`/`latency` come from server props threaded through OverviewBoard.
 */
const IndexLeaderboardRow = memo(function IndexLeaderboardRow({
  row,
  index,
  isOpen,
  ranked,
  selectedGeo,
  weights,
  latency,
  toggle,
}: {
  row: IndexRow;
  index: number;
  isOpen: boolean;
  ranked: boolean;
  selectedGeo: GeoRegion | null;
  weights: ScoringWeights;
  /** Per-provider method→geo→p50/p95 slice for the expanded grid. */
  latency: Record<string, Record<string, LatencyCell>> | undefined;
  toggle: (id: string) => void;
}) {
  const p = row;
  const isLeader = index === 0;
  // Color coding by score tier (green / amber / red). The score number is
  // tinted, and a score-proportional gradient line sits below the row (black →
  // tier color, ending at the score position) so the gaps between providers
  // read at a glance.
  const tierColor = ranked ? scoreColor(p.score) : null;
  // #1's name + rank take the provider's brand color (overrides the default
  // accent). Falls back to the accent if no brand color.
  const leaderColor = isLeader ? brandColorFor(p.id) : null;
  const lineStyle =
    ranked && p.score > 0
      ? {
          backgroundImage: `linear-gradient(90deg, transparent 0%, ${tierColor} ${p.score}%, transparent ${p.score}%)`,
        }
      : undefined;
  return (
    <li key={p.id} className="idx-li">
      <div
        className={
          "idx-row" + (isLeader ? " idx-row-leader" : "") + (isOpen ? " idx-row-open" : "")
        }
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => toggle(p.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(p.id);
          }
        }}
      >
        <span className="idx-rank" style={leaderColor ? { color: leaderColor } : undefined}>
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="idx-name" style={leaderColor ? { color: leaderColor } : undefined}>
          {p.name}
        </span>
        {/* Collapsed relative metrics — readable at a glance without
            expanding. Reset to small mono type so they don't inherit the
            row's display font. */}
        <span className="idx-rowstats">
          <span className="idx-rowstat">
            <b>{(p.winRate * 100).toFixed(0)}</b>
            <i>% win</i>
          </span>
          <span className="idx-rowstat">
            <b>{(p.success * 100).toFixed(1)}</b>
            <i>% correct</i>
          </span>
        </span>
        {(() => {
          const scoreEl = (
            <span className="idx-score" style={tierColor ? { color: tierColor } : undefined}>
              {ranked ? p.score.toFixed(1) : "—"}
            </span>
          );
          const hasBreakdown =
            ranked &&
            p.score > 0 &&
            (selectedGeo ? p.subs != null : (p.regionBlend?.length ?? 0) > 0);
          if (!hasBreakdown) return scoreEl;
          return (
            <span onClick={(e) => e.stopPropagation()}>
              <Tooltip align="right" title="Score breakdown" trigger={scoreEl}>
                {/* Reset the leaderboard's display-font typography (44px,
                    -0.03em tracking, line-height 1) that would otherwise
                    cascade in and garble the breakdown text. */}
                <div className="text-left font-normal normal-case tracking-normal leading-normal">
                  {selectedGeo && p.subs ? (
                    <>
                      <div className="font-mono text-[11px] text-neutral-400 mb-0.5">
                        Region score
                      </div>
                      <ScoreFormula weights={weights} />
                      <SubScoreBreakdown row={p.subs} weights={weights} />
                    </>
                  ) : p.regionBlend ? (
                    <>
                      <div className="font-mono text-[11px] text-neutral-400 mb-0.5">
                        Overall = Σ region × region-weight
                      </div>
                      <RegionBlendBreakdown regions={p.regionBlend} total={p.score} />
                    </>
                  ) : null}
                </div>
              </Tooltip>
            </span>
          );
        })()}
        {lineStyle && <span className="idx-score-line" style={lineStyle} aria-hidden="true" />}
        <Link
          href={`/provider/${slugForProviderId(p.id)}` as Route}
          className="idx-arrow"
          aria-label={`Open ${p.name} details page`}
          onClick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
            <path
              d="M5 12h14M13 5l7 7-7 7"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      </div>
      {/* Expanded detail slides down (grid-rows 0fr → 1fr) + fades in
          when the row is clicked, instead of popping in. */}
      <div
        className={
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none " +
          (isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")
        }
      >
        <div
          className={
            "overflow-hidden transition-opacity duration-300 ease-out " +
            (isOpen ? "opacity-100" : "opacity-0")
          }
        >
        <div className={"idx-detail" + (isLeader ? " idx-detail-leader" : "")}>
          {/* Cold-start latency by method × region — the two best-covered
              geos. Pooled across each geo's vantages (incl. Newark/EWR
              and Frankfurt/FRA). */}
          <div className="idx-mr">
            <div className="idx-mr-cap">Cold-start latency · p50 / p95 ms</div>
            <div className="idx-mr-scroll">
              <table className="idx-mrtable">
                <thead>
                  <tr>
                    <th />
                    {OVERVIEW_GEOS.map((g) => (
                      <th key={g}>{GEO_REGION_LABELS[g]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {OVERVIEW_METHODS.map((m) => (
                    <tr key={m}>
                      <td className="idx-mr-method">
                        <code>{m}</code>
                      </td>
                      {OVERVIEW_GEOS.map((g) => {
                        const cell = latency?.[m]?.[g];
                        const has = cell && (cell.p50 != null || cell.p95 != null);
                        return (
                          <td key={g} className="idx-mr-cell">
                            {has ? (
                              <>
                                {fmtMs(cell!.p50)}
                                <span className="idx-mr-sep"> / </span>
                                {fmtMs(cell!.p95)}
                              </>
                            ) : (
                              <span className="idx-mr-empty">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="idx-mr-note">
              Showing 3 examples of the {ALL_METHODS.length} benchmarked methods. The
              score and stats above only represent getTransaction.
            </div>
          </div>
          {/* Secondary line: the overall relative metrics for this view. */}
          <div className="idx-detail-secondary">
            <span className="idx-ds">
              <span className="idx-ds-l">win rate</span>
              <span className="idx-ds-v">{(p.winRate * 100).toFixed(0)}<i>%</i></span>
            </span>
            <span className="idx-ds">
              <span className="idx-ds-l">samples</span>
              <span className="idx-ds-v">{p.samples.toLocaleString()}</span>
            </span>
            <span className="idx-ds">
              <span className="idx-ds-l">correct</span>
              {p.failed > 0 ? (
                <span onClick={(e) => e.stopPropagation()}>
                  <Tooltip align="right" title="Failure breakdown" trigger={
                    <span className="idx-ds-v" style={{ cursor: "help" }}>
                      {(p.success * 100).toFixed(1)}<i>%</i>
                    </span>
                  }>
                    <div className="text-left font-normal normal-case tracking-normal leading-normal">
                      <FailureBreakdownList breakdown={p.failure_breakdown} totalFailed={p.failed} />
                    </div>
                  </Tooltip>
                </span>
              ) : (
                <span className="idx-ds-v">{(p.success * 100).toFixed(1)}<i>%</i></span>
              )}
            </span>
          </div>
        </div>
        </div>
      </div>
    </li>
  );
});

export function IndexLeaderboard({
  rawPerGeo,
  selectedGeo,
  weights,
  methodRegionLatency = {},
}: {
  rawPerGeo: RawGeoOutcome[];
  selectedGeo: GeoRegion | null;
  /** Scoring weights — controlled by the parent (OverviewBoard presets). */
  weights: ScoringWeights;
  /** Expanded-row latency grid data (provider → method → geo → p50/p95). */
  methodRegionLatency?: MethodRegionLatency;
}) {
  // Weights are controlled by OverviewBoard (workload presets). Re-scoring runs
  // client-side off the raw per-geo aggregates, so changing a preset re-ranks
  // instantly without a refetch.
  const rows: IndexRow[] = useMemo(() => {
    const perGeo = rawPerGeo.map((o) => ({
      geo: o.geo,
      rows: o.rows,
      eligible: o.eligible,
      scored: scorePerGeo(o, weights),
    }));

    if (selectedGeo && perGeo[0]) {
      const { rows: single } = buildSingleLeaderRows(perGeo[0]);
      return single.map((r) => ({
        id: r.provider_id,
        name: r.provider_name,
        score: r.total,
        p50: r.p50_ms,
        p95: r.p95_ms,
        p99: r.p99_ms,
        winRate: r.win_rate,
        samples: r.sample_count_valid,
        success: r.success_rate_calls,
        failed: r.sample_count_failed,
        failure_breakdown: r.failure_breakdown,
        subs: {
          latency_sub: r.latency_sub,
          win_sub: r.win_sub,
          reliability_sub: r.reliability_sub,
          correctness_sub: r.correctness_sub,
          freshness_sub: r.freshness_sub,
          total: r.total,
        },
        regionBlend: null,
      }));
    }

    const map = new Map<GeoRegion, ScoredProvider[]>();
    for (const o of perGeo) map.set(o.geo, o.scored);
    const blended = blendRegionScores(map, DEFAULT_REGION_WEIGHTS);
    const overall = buildOverallLeaderRows(blended, perGeo);
    return overall.map((r) => {
      // Overall = Σ region_score × normalized region-weight (renormalized over
      // the regions where this provider is eligible — matches blendRegionScores).
      const present = GEO_REGIONS.filter((g) => r.per_geo[g] != null);
      const wSum = present.reduce((s, g) => s + (DEFAULT_REGION_WEIGHTS[g] ?? 0), 0);
      const regionBlend =
        wSum > 0
          ? present
              .map((g) => ({
                label: GEO_REGION_LABELS[g],
                weight: (DEFAULT_REGION_WEIGHTS[g] ?? 0) / wSum,
                score: r.per_geo[g]!.total,
              }))
              .filter((x) => x.weight > 0)
          : [];
      return {
        id: r.provider_id,
        name: r.provider_name,
        score: r.total,
        p50: r.p50_blend,
        p95: r.p95_blend,
        p99: r.p99_blend,
        winRate: r.win_rate,
        samples: r.total_calls,
        success: r.success_rate_calls,
        failed: r.total_failed,
        failure_breakdown: r.failure_breakdown,
        subs: null,
        regionBlend,
      };
    });
  }, [rawPerGeo, selectedGeo, weights]);

  // During warmup no provider has cleared the eligibility floor, so every score
  // is 0. Rank by samples instead and show "—" scores so we don't crown an
  // arbitrary provider.
  const ranked = rows.some((r) => r.score > 0);
  const ordered = useMemo(
    () =>
      ranked
        ? [...rows].sort((a, b) => b.score - a.score)
        : [...rows].sort((a, b) => b.samples - a.samples),
    [rows, ranked],
  );

  // Rows start collapsed — the Overview leads with relative metrics (win rate /
  // success / score) inline on each row; expanding reveals the per-method ×
  // per-region latency grid.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // Stable identity so memoized rows don't re-render just because the parent
  // re-rendered (e.g. a sibling toggled open). Uses the functional setOpen form,
  // so an empty dep array carries no stale-closure risk.
  const toggle = useCallback(
    (id: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  if (ordered.length === 0) {
    return (
      <section className="lb-index">
        <div className="idx-head">
          <span className="section-kicker">01 · Live leaderboard</span>
        </div>
        <p className="prov-empty">No data.</p>
      </section>
    );
  }

  return (
    <section className="lb-index">
      <ol className="idx-list">
        {ordered.map((p, i) => (
          <IndexLeaderboardRow
            key={p.id}
            row={p}
            index={i}
            isOpen={open.has(p.id)}
            ranked={ranked}
            selectedGeo={selectedGeo}
            weights={weights}
            latency={methodRegionLatency[p.id]}
            toggle={toggle}
          />
        ))}
      </ol>
    </section>
  );
}
