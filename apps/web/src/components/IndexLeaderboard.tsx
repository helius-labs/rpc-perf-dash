"use client";

/**
 * IndexLeaderboard — the "Index, dark" typographic ranked list. Bold ranked
 * type with #1 dominating by scale, an arrow per row linking to the provider
 * deep-dive, and a click-to-expand stat strip + per-method×region latency grid.
 *
 * The rows are PRE-BUILT by OverviewBoard (buildPresetLeaderRows over the
 * preset cube) and passed in, so the hero logo and this list rank by the exact
 * same blend — and the heavy method-blend runs once per weight change, not
 * twice. The score is a workload-preset blend across methods AND regions, so the
 * row shows the blended composite + normalized sub-scores + meaningful
 * aggregates (win/correct/samples), NOT a cross-method latency percentile. Real
 * per-method latency lives in the expanded grid.
 */

import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  type RegionWeights,
  type ScoringWeights,
} from "@rpcbench/shared/scoring";
import { GEO_REGIONS, GEO_REGION_LABELS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import { slugForProviderId } from "@rpcbench/shared/providers";
import { brandColorFor } from "@/lib/providerColors";
import { FloatingTooltip } from "./FloatingTooltip";
import {
  FailureBreakdownList,
  ScoreFormula,
  SubScoreBreakdown,
  scoreColor,
  type FailureBreakdownEntry,
  type PresetLeaderRow,
} from "./leaderboardShared";

/** L/W/R/C/F sub-scores for the score-breakdown tooltip. */
interface ScoreSubs {
  latency_sub: number;
  win_sub: number;
  reliability_sub: number;
  correctness_sub: number;
  freshness_sub: number;
  total: number;
}

/** p50/p95 latency for one (provider × method × geo) cell in the expanded row. */
export interface LatencyCell {
  p50: number | null;
  p95: number | null;
}

/**
 * provider id → method → geo → latency. Assembled server-side (page.tsx) from
 * the preset cube for the expanded-row method×region grid.
 */
export type MethodRegionLatency = Record<string, Record<string, Record<string, LatencyCell>>>;

/**
 * Geos surfaced in the expanded-row latency grid, shown two at a time. The
 * chevron next to the second header cycles through these pairs (synced across
 * all expanded rows — see `pairIdx`).
 */
const GEO_PAIRS: ReadonlyArray<readonly [GeoRegion, GeoRegion]> = [
  ["na-east", "eu-central"],
  ["ap-northeast", "na-west"],
  ["eu-west", "ap-southeast"],
];

interface IndexRow {
  id: string;
  name: string;
  score: number;
  winRate: number;
  samples: number;
  success: number;
  // Failed-call count + per-category breakdown behind the missing success %.
  failed: number;
  failure_breakdown: FailureBreakdownEntry[];
  // Blended L/W/R/C/F sub-scores (the meaningful decomposition of the composite).
  subs: ScoreSubs;
  // Per-region composite preset score, for the "strongest regions" metric.
  regionBlend: Array<{ label: string; weight: number; score: number }>;
  // Coverage gate: providers below MIN_METHOD_COVERAGE are shown but not ranked.
  coverageOk: boolean;
  coveragePct: number;
  exclusionReason: string | null;
}

function fmtMs(v: number | null): React.ReactNode {
  return v == null ? "—" : <>{Math.round(v)}<i>ms</i></>;
}

/**
 * One leaderboard row. Memoized so expanding/collapsing a sibling row doesn't
 * re-render every other row.
 */
const IndexLeaderboardRow = memo(function IndexLeaderboardRow({
  row,
  index,
  isOpen,
  ranked,
  componentWeights,
  latency,
  gridMethods,
  scoreMethodCount,
  geos,
  onCycle,
  toggle,
}: {
  row: IndexRow;
  index: number;
  isOpen: boolean;
  ranked: boolean;
  componentWeights: ScoringWeights;
  /** Per-provider method→geo→p50/p95 slice for the expanded grid. */
  latency: Record<string, Record<string, LatencyCell>> | undefined;
  /** Methods (rows) shown in the expanded grid — a capped, high-signal subset. */
  gridMethods: ReadonlyArray<Method>;
  /** How many methods the SCORE blends (may exceed gridMethods.length). */
  scoreMethodCount: number;
  /** The region pair currently shown in the grid (from GEO_PAIRS[pairIdx]). */
  geos: readonly [GeoRegion, GeoRegion];
  /** Advance to the next region pair (synced across all rows). */
  onCycle: () => void;
  toggle: (id: string) => void;
}) {
  const p = row;
  const isLeader = index === 0 && p.coverageOk;
  const showScore = ranked && p.coverageOk && p.score > 0;
  const tierColor = showScore ? scoreColor(p.score) : null;
  const leaderColor = isLeader ? brandColorFor(p.id) : null;
  const lineStyle =
    showScore
      ? {
          backgroundImage: `linear-gradient(90deg, transparent 0%, ${tierColor} ${p.score}%, transparent ${p.score}%)`,
        }
      : undefined;
  return (
    <li key={p.id} className={"idx-li" + (p.coverageOk ? "" : " opacity-55")}>
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
        {/* Collapsed relative metrics — readable at a glance without expanding. */}
        <span className="idx-rowstats">
          {p.coverageOk ? (
            <>
              <span className="idx-rowstat">
                <b>{(p.winRate * 100).toFixed(0)}</b>
                <i>% win</i>
              </span>
              <span className="idx-rowstat">
                <b>{(p.success * 100).toFixed(1)}</b>
                <i>% correct</i>
              </span>
            </>
          ) : (
            <span className="idx-rowstat">
              <i>insufficient method coverage ({(p.coveragePct * 100).toFixed(0)}%)</i>
            </span>
          )}
        </span>
        {(() => {
          const scoreEl = (
            <span className="idx-score" style={tierColor ? { color: tierColor } : undefined}>
              {showScore ? p.score.toFixed(1) : "—"}
            </span>
          );
          if (!showScore) return scoreEl;
          return (
            <span onClick={(e) => e.stopPropagation()}>
              <FloatingTooltip title="Score breakdown" trigger={scoreEl}>
                <div className="text-left font-normal normal-case tracking-normal leading-normal">
                  <div className="font-mono text-[11px] text-neutral-400 mb-0.5">
                    Blended across {scoreMethodCount} method{scoreMethodCount === 1 ? "" : "s"}
                  </div>
                  <ScoreFormula weights={componentWeights} />
                  <SubScoreBreakdown row={p.subs} weights={componentWeights} />
                </div>
              </FloatingTooltip>
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
      {/* Expanded detail. */}
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
          <div className="idx-mr">
            <div className="idx-mr-cap">Cold-start latency · p50 / p95 ms</div>
            <div className="idx-mr-scroll">
              <table className="idx-mrtable">
                <thead>
                  <tr>
                    <th />
                    {geos.map((g) => (
                      <th key={g}>{GEO_REGION_LABELS[g]}</th>
                    ))}
                    <th className="idx-mr-cyclecol">
                      <button
                        type="button"
                        className="idx-mr-cycle"
                        aria-label="Show next regions"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCycle();
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                          <path
                            d="M9 6l6 6-6 6"
                            stroke="currentColor"
                            strokeWidth="2"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {gridMethods.map((m) => (
                    <tr key={m}>
                      <td className="idx-mr-method">
                        <code>{m}</code>
                      </td>
                      {geos.map((g) => {
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
                      <td className="idx-mr-cyclecol" aria-hidden="true" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="idx-mr-note">
              {gridMethods.length < scoreMethodCount ? (
                <>Showing {gridMethods.length} of the {scoreMethodCount} methods blended into this score.</>
              ) : (
                <>All {scoreMethodCount} method{scoreMethodCount === 1 ? "" : "s"} in this score are shown.</>
              )}
            </div>
          </div>
          {/* Secondary line: the overall relative metrics for this view. */}
          <div className="idx-detail-secondary">
            <span className="idx-ds">
              <span className="idx-ds-l">samples</span>
              <span className="idx-ds-v">{p.samples.toLocaleString()}</span>
            </span>
            <span className="idx-ds">
              <span className="idx-ds-l">win rate</span>
              <span className="idx-ds-v">{(p.winRate * 100).toFixed(0)}<i>%</i></span>
            </span>
            <span className="idx-ds">
              <span className="idx-ds-l">correct</span>
              {p.failed > 0 ? (
                <span onClick={(e) => e.stopPropagation()}>
                  <FloatingTooltip title="Failure breakdown" trigger={
                    <span className="idx-ds-v" style={{ cursor: "help" }}>
                      {(p.success * 100).toFixed(1)}<i>%</i>
                    </span>
                  }>
                    <div className="text-left font-normal normal-case tracking-normal leading-normal">
                      <FailureBreakdownList breakdown={p.failure_breakdown} totalFailed={p.failed} />
                    </div>
                  </FloatingTooltip>
                </span>
              ) : (
                <span className="idx-ds-v">{(p.success * 100).toFixed(1)}<i>%</i></span>
              )}
            </span>
            {p.regionBlend.length > 0 && (() => {
              const top = [...p.regionBlend]
                .sort((a, b) => b.score - a.score)
                .slice(0, 2)
                .map((r) => r.label);
              const topSet = new Set(top);
              return (
                <span className="idx-ds">
                  <span className="idx-ds-l">strongest regions</span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <FloatingTooltip title="Region weights" trigger={
                      <span className="idx-ds-v idx-ds-regions underline decoration-dotted decoration-muted underline-offset-[3px]" style={{ cursor: "help" }}>
                        {top.join(" / ")}
                      </span>
                    }>
                      <div className="text-left font-normal normal-case tracking-normal leading-normal">
                        <div className="font-mono text-[11px] text-neutral-400 mb-1">
                          Region weights in the overall blend
                        </div>
                        {[...p.regionBlend]
                          .sort((a, b) => b.weight - a.weight)
                          .map((r) => {
                            const isTop = topSet.has(r.label);
                            return (
                              <div key={r.label} className="flex justify-between gap-6 text-[11px] leading-snug">
                                <span className={isTop ? "text-accent font-medium" : "text-neutral-300"}>
                                  {r.label}
                                </span>
                                <span className={"font-mono tabular-nums " + (isTop ? "text-accent" : "text-neutral-400")}>
                                  {(r.weight * 100).toFixed(0)}%
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </FloatingTooltip>
                  </span>
                </span>
              );
            })()}
          </div>
        </div>
        </div>
      </div>
    </li>
  );
});

export function IndexLeaderboard({
  rows,
  componentWeights,
  regionWeights,
  methodRegionLatency = {},
  gridMethods,
  scoreMethodCount,
}: {
  /** Pre-built preset rows (from OverviewBoard's single blend). */
  rows: PresetLeaderRow[];
  /** Component weights, for the score-breakdown tooltip. */
  componentWeights: ScoringWeights;
  /** Preset region weights, for the "strongest regions" weight tooltip. */
  regionWeights: Partial<RegionWeights>;
  /** Expanded-row latency grid data (provider → method → geo → p50/p95). */
  methodRegionLatency?: MethodRegionLatency;
  /** Methods shown in each expanded-row grid — a capped, high-signal subset. */
  gridMethods: ReadonlyArray<Method>;
  /** How many methods the score blends (for the grid note). */
  scoreMethodCount: number;
}) {
  const indexRows: IndexRow[] = useMemo(() => {
    return rows.map((r) => {
      // Region weights normalized over the geos this provider actually has.
      const present = GEO_REGIONS.filter((g) => r.per_geo[g] != null);
      const wSum = present.reduce((s, g) => s + (regionWeights[g] ?? 0), 0);
      const regionBlend =
        wSum > 0
          ? present
              .map((g) => ({
                label: GEO_REGION_LABELS[g],
                weight: (regionWeights[g] ?? 0) / wSum,
                score: r.per_geo[g]!.total,
              }))
              .filter((x) => x.weight > 0)
          : [];
      return {
        id: r.provider_id,
        name: r.provider_name,
        score: r.total,
        winRate: r.win_rate,
        samples: r.total_calls,
        success: r.success_rate_calls,
        failed: r.total_failed,
        failure_breakdown: r.failure_breakdown,
        subs: {
          latency_sub: r.latency_sub,
          win_sub: r.win_sub,
          reliability_sub: r.reliability_sub,
          correctness_sub: r.correctness_sub,
          freshness_sub: r.freshness_sub,
          total: r.total,
        },
        regionBlend,
        coverageOk: r.coverage_ok,
        coveragePct: r.coverage_pct,
        exclusionReason: r.exclusion_reason,
      };
    });
  }, [rows, regionWeights]);

  // During warmup no provider has cleared the eligibility floor.
  const ranked = indexRows.some((r) => r.coverageOk && r.score > 0);

  // First place starts expanded by default; the rest collapsed. (Only the
  // initial mount — once the user toggles, their choices persist; switching
  // presets remounts via key= and re-expands the new #1.)
  const [open, setOpen] = useState<Set<string>>(() => {
    const first = rows[0]?.provider_id;
    return new Set(first ? [first] : []);
  });
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

  const [pairIdx, setPairIdx] = useState(0);
  const cyclePair = useCallback(
    () => setPairIdx((i) => (i + 1) % GEO_PAIRS.length),
    [],
  );

  if (indexRows.length === 0) {
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
        {indexRows.map((p, i) => (
          <IndexLeaderboardRow
            key={p.id}
            row={p}
            index={i}
            isOpen={open.has(p.id)}
            ranked={ranked}
            componentWeights={componentWeights}
            latency={methodRegionLatency[p.id]}
            gridMethods={gridMethods}
            scoreMethodCount={scoreMethodCount}
            geos={GEO_PAIRS[pairIdx]!}
            onCycle={cyclePair}
            toggle={toggle}
          />
        ))}
      </ol>
    </section>
  );
}
