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
import { GEO_REGIONS, GEO_REGION_LABELS, type GeoRegion } from "@rpcbench/shared/types";
import { brandColorFor, colorFor } from "@/lib/providerColors";
import { ExportButtons } from "./ExportButtons";
import { toCSV } from "@/lib/exportData";

interface ProviderCol {
  id: string;
  name: string;
}
interface PctPair {
  p50: number | null;
  p95: number | null;
}
interface CellValue {
  cold: PctPair;
  warm: PctPair;
}
interface BreakdownRow {
  key: string;
  label: string;
  isCode?: boolean;
  values: Record<string, CellValue>;
}
/** Flat (geo × method × provider × mode) cube rows powering the drill-down. */
interface CubeRow {
  geo: GeoRegion;
  method: string;
  provider_id: string;
  connection_mode: "cold" | "warm";
  p50: number | null;
  p95: number | null;
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
  methodRows,
  regionRows,
  cubeRows,
  infraLabel,
}: {
  providers: ProviderCol[];
  methodRows: BreakdownRow[];
  regionRows: BreakdownRow[];
  /** Flat (geo × method × provider × mode) cube for the click-to-expand drill-down. */
  cubeRows: CubeRow[];
  /** Display name of the selected Infra pill (worker_provider). Undefined =
   *  pooled across all infra; when set, every value reflects that one cloud. */
  infraLabel?: string | undefined;
}) {
  const [tab, setTab] = useState<"method" | "region">("method");
  const [percentile, setPercentile] = useState<"p50" | "p95">("p95");
  const [mode, setMode] = useState<"cold" | "warm">("cold");
  const [open, setOpen] = useState<Set<string>>(() => new Set());

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

  // By-method rows are sorted alphabetically (matches the method filter
  // dropdown); region rows keep their incoming (geo) order.
  const rows = useMemo(
    () =>
      tab === "method"
        ? [...methodRows].sort((a, b) => a.label.localeCompare(b.label))
        : regionRows,
    [tab, methodRows, regionRows],
  );

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
            {mode} {percentile} latency by method &amp; region
            {infraLabel ? <span className="text-fg2"> on {infraLabel}</span> : null}
          </h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-[3px] p-[3px] bg-bg border border-line rounded-full">
            {(["cold", "warm"] as const).map((mm) => (
              <button key={mm} type="button" className={pillCls(mode === mm)} onClick={() => setMode(mm)}>
                {mm}
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
          <ExportButtons
            filename={`rpc-by-${tab}-${mode}-${percentile}`}
            buildCsv={() =>
              toCSV(
                [firstCol, ...providers.map((p) => p.name)],
                rows.map((r) => [
                  r.label,
                  ...providers.map((p) => r.values[p.id]?.[mode]?.[percentile] ?? null),
                ]),
              )
            }
            buildJson={() => ({
              dimension: tab,
              mode,
              percentile,
              providers: providers.map((p) => ({ id: p.id, name: p.name })),
              rows: rows.map((r) => ({ key: r.key, label: r.label, values: r.values })),
            })}
          />
        </div>
      </div>

      <div className="border-t border-line overflow-auto max-h-[560px]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 bg-bg z-[3] text-left font-geistmono text-[10px] font-medium tracking-[0.14em] uppercase text-muted py-2.5 pr-3 md:pr-4 border-b border-line">
                {firstCol}
              </th>
              {providers.map((p) => (
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
                    <td className="sticky left-0 bg-bg z-[1] py-0 pr-3 md:pr-4 align-middle whitespace-nowrap group-hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--bg))]">
                      {r.isCode ? (
                        <code className="font-geistmono text-[12.5px] text-fg">{r.label}</code>
                      ) : (
                        <span className="text-fg2 font-medium text-[13px]">{r.label}</span>
                      )}
                    </td>
                    <RowCells
                      row={r}
                      providers={providers}
                      mode={mode}
                      percentile={percentile}
                      cellCls="py-0 px-3 md:px-4 align-middle min-w-[96px] md:min-w-[110px]"
                    />
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line/60 last:border-b-0">
                      <td colSpan={providers.length + 1} className="p-0">
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
                                  {providers.map((p) => (
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
                                    <td className="py-0 pr-3 md:pr-4 align-middle whitespace-nowrap">
                                      {sr.isCode ? (
                                        <code className="font-geistmono text-[12.5px] text-fg2">
                                          {sr.label}
                                        </code>
                                      ) : (
                                        <span className="text-fg2 font-medium text-[13px]">{sr.label}</span>
                                      )}
                                    </td>
                                    <RowCells
                                      row={sr}
                                      providers={providers}
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
