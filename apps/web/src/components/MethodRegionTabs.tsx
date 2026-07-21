"use client";

/**
 * Per-method / per-region latency breakdown with two tabs (By method / By
 * region). Each cell is a p50/p95-latency bar; the fastest provider in a row is
 * accent-highlighted. Clicking a row expands an inset sub-grid revealing the
 * collapsed third axis of the method × region × provider cube: a method row
 * breaks out by region, a region row breaks out by method. Pricing/Incidents
 * tabs from the original design are intentionally omitted (no live data).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GEO_REGIONS, GEO_REGION_LABELS, type GeoRegion, type Method } from "@rpcbench/shared/types";
import { brandColorFor, colorFor } from "@/lib/providerColors";
import { ExportButtons } from "./ExportButtons";
import { MethodSelectPill } from "./MethodSelectPill";
import { toCSV } from "@/lib/exportData";
import { usePopover } from "@/lib/usePopover";

export interface ProviderCol {
  id: string;
  name: string;
}
export interface PctPair {
  p50: number | null;
  p95: number | null;
}
export interface CellValue {
  cold: PctPair;
  warm: PctPair;
}
export interface BreakdownRow {
  key: string;
  label: string;
  isCode?: boolean;
  values: Record<string, CellValue>;
}
/** Flat (geo × method × provider × mode) cube rows powering the drill-down. */
export interface CubeRow {
  geo: GeoRegion;
  method: string;
  provider_id: string;
  connection_mode: "cold" | "warm";
  p50: number | null;
  p95: number | null;
}
/** Pre-built table data for one infra (pooled `all` or a single cloud). The page
 *  ships one of these per active infra so the table's Infra dropdown can switch
 *  client-side with no server round-trip. */
export interface InfraTableData {
  methodRows: BreakdownRow[];
  cubeRows: CubeRow[];
}
/** One option in the table's Infra dropdown (`all` = pooled across clouds). */
export interface InfraOption {
  id: string;
  label: string;
}

function dotColor(id: string): string {
  return brandColorFor(id) ?? colorFor(id);
}

function pillCls(active: boolean): string {
  return (
    "border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] cursor-pointer transition-colors " +
    (active ? "bg-fg text-bg" : "bg-transparent text-fg2 hover:text-fg")
  );
}

// Trigger styling for the Method / Infra / RPC dropdown pills — an OUTLINE pill
// (dark bg + border), with the ▾ affordance. Kept identical to the chart's
// method dropdown (PerfExplorer METHOD_TRIGGER_CLS) so the three method
// dropdowns look the same.
const TRIGGER_CLS =
  "inline-flex items-center gap-1.5 px-[11px] py-[6px] text-[12px] rounded-full " +
  "font-geistmono tracking-[0.01em] cursor-pointer transition-colors " +
  "bg-bg border border-line text-fg2 hover:text-fg";

/** Single-select Infra dropdown — scopes the whole table to one cloud (or the
 *  pooled `all` view), client-side and independent of the chart's Infra filter. */
function InfraDropdown({
  options,
  selected,
  onSelect,
}: {
  options: InfraOption[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
  const label = options.find((o) => o.id === selected)?.label ?? options[0]?.label ?? "Infra";
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
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">
          ▾
        </span>
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

/** Multi-select RPC dropdown — toggles which provider columns are shown. All
 *  checked by default; the last visible column can't be removed. */
function RpcDropdown({
  providers,
  visible,
  onToggle,
  onShowAll,
}: {
  providers: ProviderCol[];
  visible: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();
  const allShown = visible.size === providers.length;
  const label = allShown ? "All RPCs" : `${visible.size} RPC${visible.size === 1 ? "" : "s"}`;
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
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">
          ▾
        </span>
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
            {providers.map((p) => {
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
                    <span
                      className="inline-block w-[7px] h-[7px] rounded-full shrink-0"
                      style={{ background: dotColor(p.id) }}
                    />
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

/**
 * The provider `<td>`s for one breakdown row — shared by the top-level table and
 * the expanded sub-grid so the winner accent, bar width and `—` empty state are
 * identical at both nesting levels. Computes the row's min/max internally.
 */
function RowCells({
  row,
  providers,
  mode,
  percentile,
  cellCls,
}: {
  row: BreakdownRow;
  providers: ProviderCol[];
  mode: "cold" | "warm";
  percentile: "p50" | "p95";
  cellCls: string;
}) {
  const cell = (id: string): number | null => row.values[id]?.[mode]?.[percentile] ?? null;
  const vals = providers.map((p) => cell(p.id)).filter((v): v is number => v != null);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 0;
  return (
    <>
      {providers.map((p) => {
        const v = cell(p.id);
        const best = v != null && v === min && vals.length > 1;
        const pct = v != null && max > 0 ? Math.max(6, (v / (max * 1.1)) * 100) : 0;
        return (
          // The row's winner is marked with a faint white highlight behind the
          // whole cell (subtle enough to keep the white/accent text legible).
          <td
            key={p.id}
            className={
              cellCls + (best ? " bg-[color-mix(in_srgb,var(--text)_9%,transparent)]" : "")
            }
          >
            {v == null ? (
              <span className="text-muted font-geistmono text-[12px]">—</span>
            ) : (
              <div className="flex flex-col gap-0.5 min-w-0">
                <span
                  className={
                    "font-geistmono text-[12.5px] leading-none tabular-nums " +
                    (best ? "text-accent font-medium" : "text-fg")
                  }
                >
                  {v.toFixed(1)}
                  <span className="text-muted ml-0.5">ms</span>
                </span>
                <span className="block h-[4px] rounded-sm bg-line2 overflow-hidden">
                  <span
                    className="block h-full rounded-sm"
                    style={{ width: pct + "%", background: dotColor(p.id), opacity: best ? 1 : 0.55 }}
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

export function MethodRegionTabs({
  providers,
  byInfra,
  infraOptions,
  selectedMethod,
  embed = false,
}: {
  providers: ProviderCol[];
  /** Pre-built table data per infra; the Infra dropdown picks one client-side. */
  byInfra: Record<string, InfraTableData>;
  /** Infra dropdown options (`all` = pooled, then one per active cloud). */
  infraOptions: InfraOption[];
  /** The page's first selected method — used to derive the By-region rows from
   *  the active infra's cube (so they track the table's own Infra filter). */
  selectedMethod: string;
  /** Embed mode: hides the export control (all filters stay interactive). Set by
   *  the /embed/latency-table route; omitted everywhere else. */
  embed?: boolean;
}) {
  const [tab, setTab] = useState<"method" | "region">("method");
  const [percentile, setPercentile] = useState<"p50" | "p95">("p95");
  const [mode, setMode] = useState<"cold" | "warm">("cold");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // Table-local Infra filter — independent of the chart's `wp` filter.
  const [tableInfra, setTableInfra] = useState<string>(() => infraOptions[0]?.id ?? "all");
  // By-region tab's own method selector. Seeds from the page's method, then is
  // fully client-side and independent (the chart's method no longer navigates,
  // so the table doesn't follow it). The table already holds every method's cube
  // data, so switching here is display-only — no fetch.
  const [regionMethod, setRegionMethod] = useState<string>(selectedMethod);
  // RPC column show/hide — the set of currently-visible provider ids (all shown
  // by default). Toggling never empties (the last column stays). Initialized
  // lazily from props (the benchmarked provider set is stable).
  const [visibleProviders, setVisibleProviders] = useState<Set<string>>(
    () => new Set(providers.map((p) => p.id)),
  );
  // By-method tab's method multi-select — mirrors the chart's method dropdown.
  // All methods selected by default; toggling never empties (last one is a
  // no-op). Seeded lazily from the initial active infra's method set (every
  // infra carries the same ALL_METHODS set).
  const [selectedMethods, setSelectedMethods] = useState<Set<string>>(
    () => new Set((byInfra[tableInfra] ?? byInfra.all)?.methodRows.map((r) => r.key) ?? []),
  );

  const active = byInfra[tableInfra] ?? byInfra.all ?? { methodRows: [], cubeRows: [] };
  const methodRows = active.methodRows;
  const cubeRows = active.cubeRows;
  const infraLabel =
    tableInfra === "all" ? undefined : infraOptions.find((o) => o.id === tableInfra)?.label;

  // Columns to render — providers filtered to the RPC multi-select.
  const shownProviders = useMemo(
    () =>
      visibleProviders.size === providers.length
        ? providers
        : providers.filter((p) => visibleProviders.has(p.id)),
    [providers, visibleProviders],
  );
  const toggleProvider = useCallback(
    (id: string) =>
      setVisibleProviders((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          if (next.size === 1) return prev; // keep at least one column
          next.delete(id);
        } else next.add(id);
        return next;
      }),
    [],
  );
  const showAllProviders = useCallback(
    () => setVisibleProviders(new Set(providers.map((p) => p.id))),
    [providers],
  );

  // Method options for the By-method multi-select — every method the table
  // carries, alphabetized (as Method[] so it reuses the chart's MethodSelectPill).
  const methodOptions = useMemo<Method[]>(
    () => methodRows.map((r) => r.key as Method).sort((a, b) => a.localeCompare(b)),
    [methodRows],
  );
  const toggleMethod = useCallback(
    (m: Method) =>
      setSelectedMethods((prev) => {
        const next = new Set(prev);
        if (next.has(m)) {
          if (next.size === 1) return prev; // keep at least one method
          next.delete(m);
        } else next.add(m);
        return next;
      }),
    [],
  );
  const selectOnlyMethod = useCallback((m: Method) => setSelectedMethods(new Set([m])), []);
  const selectAllMethods = useCallback(
    () => setSelectedMethods(new Set(methodRows.map((r) => r.key))),
    [methodRows],
  );

  // Method options for the By-region selector — every method the table carries,
  // alphabetized (as {id,label} so it reuses the single-select dropdown below).
  const regionMethodOptions = useMemo<InfraOption[]>(
    () =>
      methodRows
        .map((r) => ({ id: r.key, label: r.label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [methodRows],
  );

  // By-region rows derived from the active infra's cube, sliced to the table's
  // own selected method (`regionMethod`) and grouped by geo (canonical order,
  // only geos with data). Keeps the By-region table on the table's own Infra +
  // method filters without an extra server fetch.
  const regionRows = useMemo<BreakdownRow[]>(() => {
    const byGeoProv = new Map<string, Map<string, CellValue>>();
    for (const r of cubeRows) {
      if (r.method !== regionMethod) continue;
      let pm = byGeoProv.get(r.geo);
      if (!pm) {
        pm = new Map();
        byGeoProv.set(r.geo, pm);
      }
      let c = pm.get(r.provider_id);
      if (!c) {
        c = { cold: { p50: null, p95: null }, warm: { p50: null, p95: null } };
        pm.set(r.provider_id, c);
      }
      c[r.connection_mode] = { p50: r.p50, p95: r.p95 };
    }
    const out: BreakdownRow[] = [];
    for (const geo of GEO_REGIONS) {
      const pm = byGeoProv.get(geo);
      if (!pm) continue;
      out.push({
        key: geo,
        label: GEO_REGION_LABELS[geo],
        isCode: false,
        values: Object.fromEntries(pm),
      });
    }
    return out;
  }, [cubeRows, regionMethod]);

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
  // Method keys never collide with geo keys, but collapse everything when the
  // dimension changes so a switched tab opens clean.
  useEffect(() => setOpen(new Set()), [tab]);

  // By-method rows are filtered to the method multi-select and sorted
  // alphabetically (matches the method filter dropdown); region rows keep their
  // incoming (geo) order. Fallback to all methods if the selection is disjoint
  // from this infra's methods (defensive — selection never empties and every
  // infra carries ALL_METHODS).
  const rows = useMemo(() => {
    if (tab !== "method") return regionRows;
    const filtered = methodRows.filter((r) => selectedMethods.has(r.key));
    const base = filtered.length ? filtered : methodRows;
    return [...base].sort((a, b) => a.label.localeCompare(b.label));
  }, [tab, methodRows, regionRows, selectedMethods]);

  // Pivot the flat cube into the two drill-down indexes once. byMethod[method]
  // = one sub-row per region (canonical GEO_REGIONS order); byGeo[geo] = one
  // sub-row per method (alpha). cold+warm are merged into a single CellValue so
  // the cold/warm + p50/p95 toggles stay client-side.
  const { byMethod, byGeo } = useMemo(() => {
    const ensureCell = (m: Map<string, CellValue>, pid: string): CellValue => {
      let c = m.get(pid);
      if (!c) {
        c = { cold: { p50: null, p95: null }, warm: { p50: null, p95: null } };
        m.set(pid, c);
      }
      return c;
    };
    // method -> geo -> provider -> cell, and geo -> method -> provider -> cell
    const methodMap = new Map<string, Map<string, Map<string, CellValue>>>();
    const geoMap = new Map<string, Map<string, Map<string, CellValue>>>();
    const nest = (
      root: Map<string, Map<string, Map<string, CellValue>>>,
      a: string,
      b: string,
      r: CubeRow,
    ) => {
      let lvl = root.get(a);
      if (!lvl) {
        lvl = new Map();
        root.set(a, lvl);
      }
      let prov = lvl.get(b);
      if (!prov) {
        prov = new Map();
        lvl.set(b, prov);
      }
      ensureCell(prov, r.provider_id)[r.connection_mode] = { p50: r.p50, p95: r.p95 };
    };
    for (const r of cubeRows) {
      nest(methodMap, r.method, r.geo, r);
      nest(geoMap, r.geo, r.method, r);
    }

    const byMethod = new Map<string, BreakdownRow[]>();
    for (const [method, gm] of methodMap) {
      const subRows: BreakdownRow[] = [];
      for (const geo of GEO_REGIONS) {
        const prov = gm.get(geo);
        if (!prov) continue; // only emit geos that actually have data
        subRows.push({
          key: geo,
          label: GEO_REGION_LABELS[geo],
          isCode: false,
          values: Object.fromEntries(prov),
        });
      }
      byMethod.set(method, subRows);
    }

    const byGeo = new Map<string, BreakdownRow[]>();
    for (const [geo, mm] of geoMap) {
      const subRows: BreakdownRow[] = [...mm.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([method, prov]) => ({
          key: method,
          label: method,
          isCode: true,
          values: Object.fromEntries(prov),
        }));
      byGeo.set(geo, subRows);
    }
    return { byMethod, byGeo };
  }, [cubeRows]);

  const subRowIndex = tab === "method" ? byMethod : byGeo;
  const subHeader = tab === "method" ? "Region" : "RPC method";
  const firstCol = tab === "method" ? "RPC method" : "Region";

  return (
    <section className="pt-10">
      <div className="flex justify-between items-end gap-3 mb-4 flex-wrap">
        <div>
          <h2 className="text-[20px] md:text-[26px] font-medium tracking-[-0.022em] mt-2 mb-0">
            Latency Table
            {infraLabel ? <span className="text-fg2"> on {infraLabel}</span> : null}
          </h2>
        </div>
        {/* Mobile: controls take the full row (instead of being squeezed beside
            the title by justify-between) so they wrap cleanly. No overflow
            container here — the Infra/Rpc dropdowns render absolute-positioned
            menus that an overflow scroll box would clip. */}
        <div className="flex items-center gap-2 flex-wrap w-full md:w-auto">
          {infraOptions.length > 1 && (
            <InfraDropdown options={infraOptions} selected={tableInfra} onSelect={setTableInfra} />
          )}
          {/* By-method method multi-select — mirrors the chart's method dropdown
              (all selected by default). Only relevant on the method tab. */}
          {tab === "method" && methodOptions.length > 1 && (
            <MethodSelectPill
              options={methodOptions}
              selected={selectedMethods}
              onToggle={toggleMethod}
              onOnly={selectOnlyMethod}
              onAll={selectAllMethods}
              triggerClass={TRIGGER_CLS}
            />
          )}
          {/* By-region method selector — only relevant on the region tab (the
              method tab already lists every method). Reuses the single-select
              dropdown; `regionMethod` is the table's own client-side method. */}
          {tab === "region" && regionMethodOptions.length > 1 && (
            <InfraDropdown
              options={regionMethodOptions}
              selected={regionMethod}
              onSelect={setRegionMethod}
            />
          )}
          <RpcDropdown
            providers={providers}
            visible={visibleProviders}
            onToggle={toggleProvider}
            onShowAll={showAllProviders}
          />
          <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
            {(["cold", "warm"] as const).map((mm) => (
              <button key={mm} type="button" className={pillCls(mode === mm)} onClick={() => setMode(mm)}>
                {mm === "cold" ? "Cold" : "Warm"}
              </button>
            ))}
          </div>
          <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
            {(["p50", "p95"] as const).map((pp) => (
              <button key={pp} type="button" className={pillCls(percentile === pp)} onClick={() => setPercentile(pp)}>
                {pp}
              </button>
            ))}
          </div>
          <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
            <button type="button" className={pillCls(tab === "method")} onClick={() => setTab("method")}>
              By method
            </button>
            <button type="button" className={pillCls(tab === "region")} onClick={() => setTab("region")}>
              By region
            </button>
          </div>
          {!embed && <ExportButtons
            filename={`rpc-by-${tab}-${mode}-${percentile}`}
            buildCsv={() =>
              toCSV(
                [firstCol, ...shownProviders.map((p) => p.name)],
                rows.map((r) => [
                  r.label,
                  ...shownProviders.map((p) => r.values[p.id]?.[mode]?.[percentile] ?? null),
                ]),
              )
            }
            buildJson={() => ({
              dimension: tab,
              mode,
              percentile,
              providers: shownProviders.map((p) => ({ id: p.id, name: p.name })),
              rows: rows.map((r) => ({ key: r.key, label: r.label, values: r.values })),
            })}
          />}
        </div>
      </div>

      <div className="border-t border-line overflow-auto max-h-[560px]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 bg-bg z-[3] text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2.5 pr-3 md:pr-4 border-b border-line">
                {firstCol}
              </th>
              {shownProviders.map((p) => (
                <th
                  key={p.id}
                  className="sticky top-0 bg-bg z-[2] text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2.5 px-3 md:px-4 border-b border-line whitespace-nowrap"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block w-[7px] h-[7px] rounded-full"
                      style={{ background: dotColor(p.id) }}
                    />
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
                    {/* Cap + truncate the label so this column can't hog width
                        and squeeze the data columns on narrow screens (generous
                        cap on lg → no truncation there; title shows the full name). */}
                    <td className="sticky left-0 bg-bg z-[1] py-0 pr-3 md:pr-4 align-middle group-hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--bg))]">
                      {r.isCode ? (
                        <code
                          className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] font-geistmono text-[12.5px] text-fg"
                          title={r.label}
                        >
                          {r.label}
                        </code>
                      ) : (
                        <span
                          className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] text-fg2 font-medium text-[13px]"
                          title={r.label}
                        >
                          {r.label}
                        </span>
                      )}
                    </td>
                    <RowCells
                      row={r}
                      providers={shownProviders}
                      mode={mode}
                      percentile={percentile}
                      cellCls="py-0 px-3 md:px-4 align-middle min-w-[96px] md:min-w-[110px]"
                    />
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line/60 last:border-b-0">
                      <td colSpan={shownProviders.length + 1} className="p-0">
                        <div className="mrtab-reveal">
                         <div className="overflow-hidden">
                          <div className="my-2 mx-1 px-3 py-2 rounded-lg border border-line/60 bg-[color-mix(in_srgb,var(--text)_3%,transparent)]">
                          {subRows.length === 0 ? (
                            <span className="font-geistmono text-[12px] text-muted">
                              No {tab === "method" ? "regional" : "per-method"} data in this window
                            </span>
                          ) : (
                            <table className="w-full border-collapse">
                              <thead>
                                <tr>
                                  <th className="text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2 pr-3 md:pr-4 whitespace-nowrap">
                                    {subHeader}
                                  </th>
                                  {shownProviders.map((p) => (
                                    <th
                                      key={p.id}
                                      className="text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2 px-3 md:px-4 whitespace-nowrap min-w-[96px] md:min-w-[110px]"
                                    >
                                      <span className="inline-flex items-center gap-1.5">
                                        <span
                                          className="inline-block w-[7px] h-[7px] rounded-full"
                                          style={{ background: dotColor(p.id) }}
                                        />
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
                                        <code
                                          className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] font-geistmono text-[12.5px] text-fg2"
                                          title={sr.label}
                                        >
                                          {sr.label}
                                        </code>
                                      ) : (
                                        <span
                                          className="block truncate max-w-[110px] sm:max-w-[170px] lg:max-w-[280px] text-fg2 font-medium text-[13px]"
                                          title={sr.label}
                                        >
                                          {sr.label}
                                        </span>
                                      )}
                                    </td>
                                    <RowCells
                                      row={sr}
                                      providers={shownProviders}
                                      mode={mode}
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
