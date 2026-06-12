"use client";

/**
 * Per-method / per-region latency breakdown with two tabs (By method / By
 * region). Each cell is a p50-latency bar; the fastest provider in a row is
 * accent-highlighted. Pricing/Incidents tabs from the original design are
 * intentionally omitted (no live data for them).
 */

import { useMemo, useState } from "react";
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

function dotColor(id: string): string {
  return brandColorFor(id) ?? colorFor(id);
}

function pillCls(active: boolean): string {
  return (
    "border-0 px-[11px] py-[5px] text-[12px] rounded-full font-geistmono tracking-[0.01em] cursor-pointer transition-colors " +
    (active ? "bg-fg text-bg" : "bg-transparent text-fg2 hover:text-fg")
  );
}

export function MethodRegionTabs({
  providers,
  methodRows,
  regionRows,
}: {
  providers: ProviderCol[];
  methodRows: BreakdownRow[];
  regionRows: BreakdownRow[];
}) {
  const [tab, setTab] = useState<"method" | "region">("method");
  const [percentile, setPercentile] = useState<"p50" | "p95">("p95");
  const [mode, setMode] = useState<"cold" | "warm">("cold");
  // By-method rows are sorted alphabetically (matches the method filter
  // dropdown); region rows keep their incoming (geo) order.
  const rows = useMemo(
    () =>
      tab === "method"
        ? [...methodRows].sort((a, b) => a.label.localeCompare(b.label))
        : regionRows,
    [tab, methodRows, regionRows],
  );
  const firstCol = tab === "method" ? "RPC method" : "Region";

  return (
    <section className="pt-10">
      <div className="flex justify-between items-end gap-3 mb-4 flex-wrap">
        <div>
          <span className="section-kicker">03 · Per-method &amp; region breakdown</span>
          <h2 className="text-[20px] md:text-[26px] font-medium tracking-[-0.022em] mt-2 mb-0">
            {mode} {percentile} latency by method &amp; region
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
              const cell = (id: string): number | null => r.values[id]?.[mode]?.[percentile] ?? null;
              const vals = providers
                .map((p) => cell(p.id))
                .filter((v): v is number => v != null);
              const min = vals.length ? Math.min(...vals) : 0;
              const max = vals.length ? Math.max(...vals) : 0;
              return (
                <tr key={r.key} className="group border-b border-line/60 last:border-b-0 hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]">
                  <td className="sticky left-0 bg-bg z-[1] py-3 pr-3 md:pr-4 align-middle whitespace-nowrap group-hover:bg-[color-mix(in_srgb,var(--text)_3%,var(--bg))]">
                    {r.isCode ? (
                      <code className="font-geistmono text-[12.5px] text-fg">{r.label}</code>
                    ) : (
                      <span className="text-fg2 font-medium text-[13px]">{r.label}</span>
                    )}
                  </td>
                  {providers.map((p) => {
                    const v = cell(p.id);
                    const best = v != null && v === min && vals.length > 1;
                    const pct = v != null && max > 0 ? Math.max(6, (v / (max * 1.1)) * 100) : 0;
                    return (
                      <td key={p.id} className="py-3 px-3 md:px-4 align-middle min-w-[96px] md:min-w-[110px]">
                        {v == null ? (
                          <span className="text-muted font-geistmono text-[12px]">—</span>
                        ) : (
                          // Orange line spans the full height (number + bar) for
                          // winners; a transparent spacer keeps non-winners aligned.
                          <div className="flex items-stretch gap-1.5">
                            <span
                              aria-hidden="true"
                              className={
                                "w-[3px] rounded-sm shrink-0 " + (best ? "bg-accent" : "bg-transparent")
                              }
                            />
                            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                              <span
                                className={
                                  "font-geistmono text-[12.5px] tabular-nums " +
                                  (best ? "text-accent font-medium" : "text-fg")
                                }
                              >
                                {v.toFixed(1)}
                                <span className="text-muted ml-0.5">ms</span>
                              </span>
                              <span className="block h-[4px] rounded-sm bg-line2 overflow-hidden">
                                <span
                                  className="block h-full rounded-sm"
                                  style={{
                                    width: pct + "%",
                                    background: dotColor(p.id),
                                    opacity: best ? 1 : 0.55,
                                  }}
                                />
                              </span>
                            </div>
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
