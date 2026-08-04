"use client";

/**
 * Sends analogue of <MethodRegionTabs>: a per-scenario / per-region landing
 * breakdown. Same two-tab, expandable-drill-down, Infra-dropdown, column-
 * multiselect shape as the RPC latency table — but sends have no cold/warm and
 * several distinct metrics, so the cold/warm toggle is replaced by a Metric pill
 * (Landing rate / Slot latency / Wall latency / Cost). The
 * p50/p95 toggle only applies to the two latency metrics. Rows = scenario
 * (By scenario) or geo (By region); columns = send targets; the drill-down
 * reveals the collapsed third axis (scenario ⇄ region).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GEO_REGIONS, GEO_REGION_LABELS, type GeoRegion } from "@rpcbench/shared/types";
import { brandColorFor, colorFor } from "@/lib/providerColors";
import { usePopover } from "@/lib/usePopover";
import { scenarioLabel } from "@/lib/sendLabels";
import type {
  SendBreakdownRow,
  SendCellValue,
  SendCubeRow,
  SendInfraTableData,
} from "@/lib/sends";

interface TargetCol {
  id: string;
  name: string;
}
interface InfraOption {
  id: string;
  label: string;
}

// The send metrics. `pct` marks the two that carry p50/p95; the others are
// single-valued (the p50/p95 toggle hides for them). `max` = higher-is-better
// (landing rate); the rest are lower-is-better.
type MetricId = "landing" | "slot" | "wall" | "cost";
interface MetricDef {
  id: MetricId;
  label: string;
  pct: boolean;
  max: boolean;
  /** Pull the scalar for this metric + percentile out of a cell. */
  pick: (c: SendCellValue, p: "p50" | "p95") => number | null;
  /** Render the scalar with its unit (value already non-null). */
  fmt: (v: number) => string;
}
const METRICS: MetricDef[] = [
  { id: "landing", label: "Landing rate", pct: false, max: true, pick: (c) => (c.landing == null ? null : c.landing * 100), fmt: (v) => v.toFixed(1) + "%" },
  { id: "slot", label: "Slot latency", pct: true, max: false, pick: (c, p) => c.slot[p], fmt: (v) => Math.round(v) + " sl" },
  { id: "wall", label: "Wall latency", pct: true, max: false, pick: (c, p) => c.wall[p], fmt: (v) => Math.round(v) + " ms" },
  { id: "cost", label: "Cost", pct: false, max: false, pick: (c) => c.cost, fmt: (v) => Math.round(v).toLocaleString() + " lam" },
];

function dotColor(id: string): string {
  return brandColorFor(id) ?? colorFor(id);
}
function pillCls(active: boolean): string {
  return (
    "border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] cursor-pointer transition-colors " +
    (active ? "bg-fg text-bg" : "bg-transparent text-fg2 hover:text-fg")
  );
}
const TRIGGER_CLS =
  "inline-flex items-center gap-1.5 px-[11px] py-[6px] text-[12px] rounded-full " +
  "font-geistmono tracking-[0.01em] cursor-pointer transition-colors " +
  "bg-bg border border-line text-fg2 hover:text-fg";

/** Single-select dropdown (Infra / By-region scenario). Mirrors the RPC table. */
function SingleSelect({
  options,
  selected,
  onSelect,
}: {
  options: InfraOption[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
  const label = options.find((o) => o.id === selected)?.label ?? options[0]?.label ?? "";
  return (
    <div className="relative inline-block shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={TRIGGER_CLS}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">▾</span>
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={panelStyle}
            className="min-w-[180px] p-1.5 rounded-md border border-line bg-bg shadow-lg max-h-[400px] overflow-y-auto"
          >
            {options.map((o) => {
              const active = o.id === selected;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onSelect(o.id);
                    setOpen(false);
                  }}
                  className={
                    "flex w-full items-center text-left rounded px-2.5 py-[6px] text-[12px] font-geistmono tracking-[0.01em] cursor-pointer transition-colors hover:bg-line/40 " +
                    (active ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                  }
                >
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Multi-select target dropdown — toggles which send-target columns are shown. */
function TargetDropdown({
  targets,
  visible,
  onToggle,
  onShowAll,
}: {
  targets: TargetCol[];
  visible: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
  const allShown = visible.size === targets.length;
  const label = allShown ? "All targets" : `${visible.size} target${visible.size === 1 ? "" : "s"}`;
  return (
    <div className="relative inline-block shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={TRIGGER_CLS}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">▾</span>
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-multiselectable
            style={panelStyle}
            className="min-w-[200px] p-1.5 rounded-md border border-line bg-bg shadow-lg max-h-[400px] overflow-y-auto"
          >
            <button
              type="button"
              onClick={onShowAll}
              className={
                "flex w-full items-center text-left rounded px-2.5 py-[6px] mb-0.5 text-[12px] font-geistmono tracking-[0.01em] cursor-pointer transition-colors hover:bg-line/40 " +
                (allShown ? "text-fg font-medium" : "text-fg2 hover:text-fg")
              }
            >
              Show all
            </button>
            {targets.map((p) => {
              const shown = visible.has(p.id);
              return (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={shown}
                  className="flex items-center rounded text-[12px] font-geistmono tracking-[0.01em] hover:bg-line/40"
                >
                  <button
                    type="button"
                    onClick={() => onToggle(p.id)}
                    aria-label={(shown ? "Hide " : "Show ") + p.name}
                    className="flex items-center pl-2.5 pr-1.5 py-[6px] shrink-0 cursor-pointer"
                  >
                    <span
                      aria-hidden
                      className={
                        "w-[14px] h-[14px] rounded-[3px] border flex items-center justify-center text-[9px] leading-none transition-colors " +
                        (shown ? "bg-fg text-bg border-fg" : "border-line text-transparent hover:border-fg2")
                      }
                    >
                      ✓
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggle(p.id)}
                    className={
                      "flex-1 min-w-0 flex items-center gap-1.5 text-left pr-3 py-[6px] cursor-pointer transition-colors " +
                      (shown ? "text-fg font-medium" : "text-fg2 hover:text-fg")
                    }
                  >
                    <span className="inline-block w-[7px] h-[7px] rounded-full shrink-0" style={{ background: dotColor(p.id) }} />
                    <span className="truncate">{p.name}</span>
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** The target `<td>`s for one row — winner accent flips by metric direction
 *  (max for landing, min for latency/cost). Bar length = value / (max·1.1)
 *  uniformly (same as the RPC table: worst/longest for lower-is-better). */
function RowCells({
  row,
  targets,
  metric,
  percentile,
  cellCls,
}: {
  row: SendBreakdownRow;
  targets: TargetCol[];
  metric: MetricDef;
  percentile: "p50" | "p95";
  cellCls: string;
}) {
  const cell = (id: string): number | null => {
    const c = row.values[id];
    return c ? metric.pick(c, percentile) : null;
  };
  const vals = targets.map((p) => cell(p.id)).filter((v): v is number => v != null);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 0;
  const best = metric.max ? max : min;
  return (
    <>
      {targets.map((p) => {
        const v = cell(p.id);
        const isBest = v != null && v === best && vals.length > 1;
        const pct = v != null && max > 0 ? Math.max(6, (v / (max * 1.1)) * 100) : 0;
        return (
          <td
            key={p.id}
            className={cellCls + (isBest ? " bg-[color-mix(in_srgb,var(--text)_9%,transparent)]" : "")}
          >
            {v == null ? (
              <span className="text-muted font-geistmono text-[12px]">—</span>
            ) : (
              <div className="flex flex-col gap-0.5 min-w-0">
                <span
                  className={
                    "font-geistmono text-[12.5px] leading-none tabular-nums " +
                    (isBest ? "text-accent font-medium" : "text-fg")
                  }
                >
                  {metric.fmt(v)}
                </span>
                <span className="block h-[4px] rounded-sm bg-line2 overflow-hidden">
                  <span
                    className="block h-full rounded-sm"
                    style={{ width: pct + "%", background: dotColor(p.id), opacity: isBest ? 1 : 0.55 }}
                  />
                </span>
              </div>
            )}
          </td>
        );
      })}
    </>
  );
}

export function SendMethodRegionTabs({
  targets,
  byInfra,
  infraOptions,
}: {
  targets: TargetCol[];
  byInfra: Record<string, SendInfraTableData>;
  infraOptions: InfraOption[];
}) {
  const [tab, setTab] = useState<"scenario" | "region">("scenario");
  const [metricId, setMetricId] = useState<MetricId>("landing");
  const [percentile, setPercentile] = useState<"p50" | "p95">("p50");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [tableInfra, setTableInfra] = useState<string>(() => infraOptions[0]?.id ?? "all");
  const [visibleTargets, setVisibleTargets] = useState<Set<string>>(() => new Set(targets.map((t) => t.id)));

  const metric = METRICS.find((m) => m.id === metricId)!;
  const active = byInfra[tableInfra] ?? byInfra.all ?? { scenarioRows: [], cubeRows: [] };
  const scenarioRows = active.scenarioRows;
  const cubeRows = active.cubeRows;
  const infraLabel = tableInfra === "all" ? undefined : infraOptions.find((o) => o.id === tableInfra)?.label;

  const shownTargets = useMemo(
    () => (visibleTargets.size === targets.length ? targets : targets.filter((t) => visibleTargets.has(t.id))),
    [targets, visibleTargets],
  );
  const toggleTarget = useCallback(
    (id: string) =>
      setVisibleTargets((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          if (next.size === 1) return prev; // keep at least one column
          next.delete(id);
        } else next.add(id);
        return next;
      }),
    [],
  );
  const showAllTargets = useCallback(() => setVisibleTargets(new Set(targets.map((t) => t.id))), [targets]);

  // By-region tab's own scenario selector (seeded to the first scenario).
  const scenarioOptions = useMemo<InfraOption[]>(
    () => scenarioRows.map((r) => ({ id: r.key, label: r.label })),
    [scenarioRows],
  );
  const [regionScenario, setRegionScenario] = useState<string>(() => scenarioRows[0]?.key ?? "");
  useEffect(() => {
    if (scenarioRows.length && !scenarioRows.some((r) => r.key === regionScenario)) {
      setRegionScenario(scenarioRows[0]!.key);
    }
  }, [scenarioRows, regionScenario]);

  // By-region rows: cube sliced to the selected scenario, grouped by geo.
  const regionRows = useMemo<SendBreakdownRow[]>(() => {
    const byGeo = new Map<string, Record<string, SendCellValue>>();
    for (const r of cubeRows) {
      if (r.scenario !== regionScenario) continue;
      const g = byGeo.get(r.geo) ?? {};
      g[r.send_target] = r.cell;
      byGeo.set(r.geo, g);
    }
    const out: SendBreakdownRow[] = [];
    for (const geo of GEO_REGIONS) {
      const g = byGeo.get(geo);
      if (!g) continue;
      out.push({ key: geo, label: GEO_REGION_LABELS[geo], isCode: false, values: g });
    }
    return out;
  }, [cubeRows, regionScenario]);

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
  useEffect(() => setOpen(new Set()), [tab]);

  const rows = tab === "scenario" ? scenarioRows : regionRows;

  // Drill-down indexes: scenario → region subrows, geo → scenario subrows.
  const { byScenario, byGeo } = useMemo(() => {
    const scen = new Map<string, Map<string, Record<string, SendCellValue>>>(); // scenario -> geo -> target -> cell
    const geo = new Map<string, Map<string, Record<string, SendCellValue>>>(); // geo -> scenario -> target -> cell
    const nest = (
      root: Map<string, Map<string, Record<string, SendCellValue>>>,
      a: string,
      b: string,
      target: string,
      cell: SendCellValue,
    ) => {
      let lvl = root.get(a);
      if (!lvl) {
        lvl = new Map();
        root.set(a, lvl);
      }
      const prov = lvl.get(b) ?? {};
      prov[target] = cell;
      lvl.set(b, prov);
    };
    for (const r of cubeRows) {
      nest(scen, r.scenario, r.geo, r.send_target, r.cell);
      nest(geo, r.geo, r.scenario, r.send_target, r.cell);
    }
    const byScenario = new Map<string, SendBreakdownRow[]>();
    for (const [scenario, gm] of scen) {
      const subRows: SendBreakdownRow[] = [];
      for (const g of GEO_REGIONS) {
        const prov = gm.get(g);
        if (!prov) continue;
        subRows.push({ key: g, label: GEO_REGION_LABELS[g], isCode: false, values: prov });
      }
      byScenario.set(scenario, subRows);
    }
    const byGeo = new Map<string, SendBreakdownRow[]>();
    for (const [g, sm] of geo) {
      const subRows = [...sm.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([scenario, prov]) => ({ key: scenario, label: scenarioLabel(scenario), isCode: false, values: prov }));
      byGeo.set(g, subRows);
    }
    return { byScenario, byGeo };
  }, [cubeRows]);

  const subRowIndex = tab === "scenario" ? byScenario : byGeo;
  const subHeader = tab === "scenario" ? "Region" : "Scenario";
  const firstCol = tab === "scenario" ? "Scenario" : "Region";

  return (
    <section className="pt-10">
      <div className="flex justify-between items-end gap-3 mb-4 flex-wrap">
        <div>
          <h2 className="text-[20px] md:text-[26px] font-medium tracking-[-0.022em] mt-2 mb-0">
            Sends Table
            {infraLabel ? <span className="text-fg2"> on {infraLabel}</span> : null}
          </h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap w-full md:w-auto">
          {infraOptions.length > 1 && (
            <SingleSelect options={infraOptions} selected={tableInfra} onSelect={setTableInfra} />
          )}
          {tab === "region" && scenarioOptions.length > 1 && (
            <SingleSelect options={scenarioOptions} selected={regionScenario} onSelect={setRegionScenario} />
          )}
          <TargetDropdown
            targets={targets}
            visible={visibleTargets}
            onToggle={toggleTarget}
            onShowAll={showAllTargets}
          />
          {/* Metric selector — the sends replacement for the RPC cold/warm toggle. */}
          <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
            {METRICS.map((m) => (
              <button key={m.id} type="button" className={pillCls(metricId === m.id)} onClick={() => setMetricId(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          {/* p50/p95 only applies to the two latency metrics. */}
          {metric.pct && (
            <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
              {(["p50", "p95"] as const).map((pp) => (
                <button key={pp} type="button" className={pillCls(percentile === pp)} onClick={() => setPercentile(pp)}>
                  {pp}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
            <button type="button" className={pillCls(tab === "scenario")} onClick={() => setTab("scenario")}>
              By scenario
            </button>
            <button type="button" className={pillCls(tab === "region")} onClick={() => setTab("region")}>
              By region
            </button>
          </div>
        </div>
      </div>

      <div className="border-t border-line overflow-auto max-h-[560px]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 bg-bg z-[3] text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2.5 pr-3 md:pr-4 border-b border-line">
                {firstCol}
              </th>
              {shownTargets.map((p) => (
                <th
                  key={p.id}
                  className="sticky top-0 bg-bg z-[2] text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2.5 px-3 md:px-4 border-b border-line whitespace-nowrap"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span className="inline-block w-[7px] h-[7px] rounded-full" style={{ background: dotColor(p.id) }} />
                    {p.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = open.has(r.key);
              const subRows = subRowIndex.get(r.key) ?? [];
              return (
                <Fragment key={r.key}>
                  <tr
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={() => toggle(r.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(r.key);
                      }
                    }}
                    className="group border-b border-line/60 cursor-pointer hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]"
                  >
                    <td className="sticky left-0 bg-bg z-[1] py-0 pr-3 md:pr-4 align-middle group-hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--bg))]">
                      {r.isCode ? (
                        <code className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] font-geistmono text-[12.5px] text-fg" title={r.label}>
                          {r.label}
                        </code>
                      ) : (
                        <span className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] text-fg2 font-medium text-[13px]" title={r.label}>
                          {r.label}
                        </span>
                      )}
                    </td>
                    <RowCells
                      row={r}
                      targets={shownTargets}
                      metric={metric}
                      percentile={percentile}
                      cellCls="py-0 px-3 md:px-4 align-middle min-w-[96px] md:min-w-[110px]"
                    />
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line/60 last:border-b-0">
                      <td colSpan={shownTargets.length + 1} className="p-0">
                        <div className="mrtab-reveal">
                          <div className="overflow-hidden">
                            <div className="my-2 mx-1 px-3 py-2 rounded-lg border border-line/60 bg-[color-mix(in_srgb,var(--text)_3%,transparent)]">
                              {subRows.length === 0 ? (
                                <span className="font-geistmono text-[12px] text-muted">
                                  No {tab === "scenario" ? "regional" : "per-scenario"} data in this window
                                </span>
                              ) : (
                                <table className="w-full border-collapse">
                                  <thead>
                                    <tr>
                                      <th className="text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2 pr-3 md:pr-4 whitespace-nowrap">
                                        {subHeader}
                                      </th>
                                      {shownTargets.map((p) => (
                                        <th
                                          key={p.id}
                                          className="text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2 px-3 md:px-4 whitespace-nowrap min-w-[96px] md:min-w-[110px]"
                                        >
                                          <span className="inline-flex items-center gap-1.5">
                                            <span className="inline-block w-[7px] h-[7px] rounded-full" style={{ background: dotColor(p.id) }} />
                                            {p.name}
                                          </span>
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {subRows.map((sr) => (
                                      <tr key={sr.key} className="border-t border-line/40">
                                        <td className="py-0 pr-3 md:pr-4 align-middle">
                                          {sr.isCode ? (
                                            <code className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] font-geistmono text-[12.5px] text-fg2" title={sr.label}>
                                              {sr.label}
                                            </code>
                                          ) : (
                                            <span className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] text-fg2 font-medium text-[13px]" title={sr.label}>
                                              {sr.label}
                                            </span>
                                          )}
                                        </td>
                                        <RowCells
                                          row={sr}
                                          targets={shownTargets}
                                          metric={metric}
                                          percentile={percentile}
                                          cellCls="py-0 px-3 md:px-4 align-middle min-w-[96px] md:min-w-[110px]"
                                        />
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
