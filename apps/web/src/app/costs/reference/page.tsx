/**
 * /costs/reference — pricing fact-check sheet.
 *
 * Compact reference for every figure encoded in lib/pricing/*.data.ts (plans,
 * per-method unit costs, streaming, rate limits), with source links so the
 * numbers driving the comparator can be checked against each provider's docs.
 * Gated behind NEXT_PUBLIC_FEATURE_COSTS and intentionally NOT in the nav —
 * reachable only via the link under the comparator's blurb.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/flags";
import { brandColorFor, logoFor } from "@/lib/providerColors";
import { BENCHMARKED_PROVIDERS } from "@rpcbench/shared/providers";
import { plansForProvider } from "@/lib/pricing/plans.data";
import { unitTableForProvider } from "@/lib/pricing/units.data";
import { streamingForProvider } from "@/lib/pricing/streaming.data";
import type { ProviderPlan, StreamingPricing, UnitCost } from "@/lib/pricing/types";

export const metadata: Metadata = {
  title: "Pricing reference — RPC cost comparator",
  description: "Fact-check sheet for the encoded RPC provider pricing, with source links.",
  robots: { index: false, follow: false },
};

// Date the encoded pricing data was last refreshed (matches *.data.ts verified_on).
const LAST_UPDATED = new Date(2026, 5, 18).toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const int = (n: number) => Math.round(n).toLocaleString("en-US");

function perMillion(v: number): string {
  return `$${(v * 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 4 })}/1M`;
}
function includedCell(p: ProviderPlan): string {
  return p.includedUnits == null ? "unmetered" : `${int(p.includedUnits)} ${p.unitName}`;
}
function overageCell(p: ProviderPlan): string {
  if (p.overageUsdPerUnit != null) return perMillion(p.overageUsdPerUnit);
  const extras = [
    p.perCallUsd != null ? `${perMillion(p.perCallUsd)} calls` : null,
    p.perGbUsd != null ? `$${p.perGbUsd}/GB` : null,
  ].filter(Boolean);
  if (extras.length) return extras.join(" + ");
  return p.capBehavior === "hard_cap" ? "hard cap" : "—";
}
function rateCell(p: ProviderPlan): string {
  const rl = p.rateLimits;
  if (!rl) return "—";
  const parts = [
    rl.cuPerSecond != null ? `${int(rl.cuPerSecond)} CU/s` : null,
    rl.rps != null ? `${int(rl.rps)} RPS` : null,
  ].filter(Boolean);
  return parts.join(" · ") || rl.note || "—";
}
function streamPricing(s: StreamingPricing): string {
  // Unavailable entries may still carry a note (e.g. "via gRPC" shred rows).
  if (!s.available) return s.note ?? "not offered";
  const parts = [
    s.perGbUsd != null ? `$${s.perGbUsd.toFixed(4)}/GB` : null,
    s.perGbUnits ? `${int(s.perGbUnits.units)} ${s.perGbUnits.unitName}/GB` : null,
    s.perMessageUsd != null ? `$${s.perMessageUsd}/msg` : null,
    s.perMessageUnits ? `${s.perMessageUnits.units} ${s.perMessageUnits.unitName}/msg` : null,
    s.perConnectionSecondUsd != null ? `$${s.perConnectionSecondUsd}/conn-sec` : null,
    s.flatMonthlyUsd != null ? `$${s.flatMonthlyUsd}/mo flat` : null,
  ].filter(Boolean);
  // Priced rows show their axes; unpriced-but-available rows (e.g. shred,
  // availability-only) fall back to the note so the detail isn't lost.
  return parts.join(" · ") || s.note || "included — no separate meter";
}
const costLabel = (c: UnitCost): string => (c.kind === "units" ? String(c.value) : c.kind);

/** Group per-method overrides by their cost so 38 entries collapse to ~3 rows. */
function groupByCost(overrides: [string, UnitCost][]): { label: string; methods: string[] }[] {
  const map = new Map<string, string[]>();
  for (const [m, c] of overrides) {
    const label = costLabel(c);
    (map.get(label) ?? map.set(label, []).get(label)!).push(m);
  }
  return [...map.entries()]
    .map(([label, methods]) => ({ label, methods }))
    .sort((a, b) => (Number(a.label) || 1e9) - (Number(b.label) || 1e9));
}
function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return (x.hostname + x.pathname).replace(/^www\./, "").replace(/\/$/, "");
  } catch {
    return u;
  }
}

export default function PricingReferencePage() {
  if (!isFeatureEnabled("costs")) notFound();

  return (
    <div className="ref-page">
      <a href="/costs" className="ref-back">
        ← Back to comparator
      </a>
      <header className="max-w-[760px] mt-2">
        <span className="section-kicker">Costs · reference</span>
        <h1 className="text-[clamp(24px,4vw,34px)] font-semibold tracking-[-0.025em] leading-[1.1] mt-2 mb-0 text-fg">
          Pricing reference
        </h1>
        <p className="mt-3 font-geistmono text-[11px] uppercase tracking-[0.12em] text-muted">
          Last updated: {LAST_UPDATED}
        </p>
      </header>

      {BENCHMARKED_PROVIDERS.map((p) => {
        const plans = plansForProvider(p.id);
        const table = unitTableForProvider(p.id);
        const streaming = streamingForProvider(p.id);
        const brand = brandColorFor(p.id);
        const logo = logoFor(p.id);
        const overrides = table ? (Object.entries(table.byMethod) as [string, UnitCost][]) : [];
        const unsupported = p.unsupported_methods ?? [];

        const sources = Array.from(
          new Set(
            [
              ...plans.map((pl) => pl.provenance.source_url),
              table?.provenance.source_url,
              ...streaming.map((s) => s.provenance.source_url),
            ].filter((u): u is string => Boolean(u)),
          ),
        );
        const planNotes = plans.filter((pl) => pl.note);

        return (
          <section key={p.id} className="ref-prov">
            <div className="ref-prov-head">
              {logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="" width={20} height={20} style={{ borderRadius: 5 }} />
              )}
              <h2 style={brand ? { color: brand } : undefined}>{p.name}</h2>
            </div>

            {/* Plans */}
            <table className="prov-table ref-table">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th className="prov-num">$/mo</th>
                  <th>Included</th>
                  <th>Overage</th>
                  <th>Rate limit</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((pl) => (
                  <tr key={pl.id}>
                    <td className="text-fg">{pl.name}</td>
                    <td className="prov-num">${int(pl.monthlyUsd)}</td>
                    <td>{includedCell(pl)}</td>
                    <td>{overageCell(pl)}</td>
                    <td>{rateCell(pl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Per-method cost — concise summary + collapsed grouped detail */}
            {table && (
              <div className="ref-methods-wrap">
                <p className="ref-line">
                  <span className="ref-tag">cost</span>
                  {table.default.kind === "units" ? (
                    <>
                      default <b>{table.default.value}</b> {table.unitName}/call
                      {overrides.length > 0 && ` · ${overrides.length} priced individually`}
                    </>
                  ) : (
                    <>
                      per-method (no flat default) · <b>{overrides.length}</b> {table.unitName} values
                    </>
                  )}
                  {unsupported.length > 0 && (
                    <>
                      {" · unsupported "}
                      {unsupported.map((m, i) => (
                        <span key={m}>
                          {i > 0 && ", "}
                          <code>{m}</code>
                        </span>
                      ))}
                    </>
                  )}
                </p>
                {overrides.length > 0 && (
                  <details className="ref-methods">
                    <summary>
                      <span className="rcc-caret">›</span> per-method {table.unitName}
                    </summary>
                    <table className="prov-table">
                      <tbody>
                        {groupByCost(overrides).map((g) => (
                          <tr key={g.label}>
                            <td>{g.label}</td>
                            <td>{g.methods.join(", ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            )}

            {/* Streaming — compact rows */}
            <div className="ref-stream">
              {streaming.map((s, i) => (
                <div key={`${s.kind}-${i}`} className="ref-stream-row">
                  <span className="ref-stream-kind">{s.kind}</span>
                  <span className="ref-stream-price">{streamPricing(s)}</span>
                </div>
              ))}
            </div>

            {/* Notes + sources — muted footer */}
            {table?.note && (
              <p className="ref-foot">
                <span className="ref-tag">cost note</span>
                {table.note}
              </p>
            )}
            {planNotes.length > 0 && (
              <p className="ref-foot">
                {planNotes.map((pl) => `${pl.name}: ${pl.note}`).join("  ·  ")}
              </p>
            )}
            <p className="ref-foot ref-sources">
              <span className="ref-tag">sources</span>
              {sources.map((u, i) => (
                <span key={u}>
                  {i > 0 && " · "}
                  <a href={u} target="_blank" rel="noopener noreferrer">
                    {shortUrl(u)} ↗
                  </a>
                </span>
              ))}
            </p>
          </section>
        );
      })}

      <style>{`
        .ref-page { padding-bottom: 48px; max-width: 880px; }
        .ref-back { display: inline-block; font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
        .ref-back:hover { color: var(--text); text-decoration: none; }

        .ref-prov { margin-top: 36px; padding-top: 22px; border-top: 1px solid var(--border); }
        .ref-prov-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
        .ref-prov-head h2 { font-size: 20px; font-weight: 600; letter-spacing: -.02em; margin: 0; color: var(--text); }

        .ref-table { font-size: 12.5px; }
        .ref-table td { color: var(--text-2); }

        .ref-line { font-size: 12.5px; line-height: 1.7; color: var(--text-2); margin: 12px 0 0; }
        .ref-line code { font-size: 11.5px; color: var(--text); }
        .ref-line b { color: var(--text); font-weight: 600; }

        .ref-tag {
          display: inline-block; font-family: var(--font-mono); font-size: 9px; letter-spacing: .12em;
          text-transform: uppercase; color: var(--muted); border: 1px solid var(--border-2);
          border-radius: 4px; padding: 1px 6px; margin-right: 8px; vertical-align: middle;
        }

        .ref-methods-wrap { margin-top: 6px; }
        .ref-methods { margin-top: 6px; }
        .ref-methods summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
        .ref-methods summary::-webkit-details-marker { display: none; }
        .ref-methods summary:hover { color: var(--text-2); }
        .ref-methods table { margin-top: 8px; max-width: 660px; }
        .ref-methods td:first-child { white-space: nowrap; font-family: var(--font-mono); font-size: 11.5px; color: var(--text); width: 1%; vertical-align: top; }
        .ref-methods td:last-child { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); line-height: 1.7; }

        .ref-stream { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 14px; }
        .ref-stream-row {
          display: inline-flex; align-items: baseline; gap: 7px; border: 1px solid var(--border);
          border-radius: 6px; padding: 4px 10px; background: var(--surface); font-size: 12px;
        }
        .ref-stream-kind { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
        .ref-stream-price { color: var(--text-2); }

        .ref-foot { font-size: 11.5px; line-height: 1.6; color: var(--muted); margin: 14px 0 0; }
        .ref-sources a { color: var(--text-2); }
        .ref-sources a:hover { color: var(--accent); }
      `}</style>
    </div>
  );
}
