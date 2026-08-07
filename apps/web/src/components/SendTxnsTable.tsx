/**
 * /challenges SENDS board table — the actual transactions the send lane
 * broadcast (from landing_tx_results), the send analogue of ChallengesTable.
 * Server-rendered (the page is force-dynamic); no live poll — send txns are the
 * settled record, not a streaming consensus fill like read challenges.
 */

import { colorFor } from "@/lib/providerColors";
import { scenarioLabel, targetLabel } from "@/lib/sendLabels";
import { SEND_OUTCOME_OPTIONS } from "@/lib/challengeFilters";
import type { SendTxnRow as Row } from "@/lib/sendTxns";

const OUTCOME_COLOR: Record<string, string> = {
  landed: "#7be0a4",
  reverted: "#f3c27a",
  not_landed: "#f08080",
  submit_error: "#e0803f",
};

function outcomeLabel(o: string): string {
  return SEND_OUTCOME_OPTIONS.find((x) => x.value === o)?.label ?? o;
}

/** Relative age; computed at render (SSR) — the page is force-dynamic so it's
 *  fresh per load. Doesn't tick like the read table (no client poll here). */
function fmtRelativeTime(t: string | Date): string {
  const ts = (typeof t === "string" ? new Date(t) : t).getTime();
  const dt = (Date.now() - ts) / 1000;
  if (dt < 60) return `${Math.max(1, Math.floor(dt))}s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
  return `${Math.floor(dt / 86400)}d ago`;
}

/** First6…last6 of a signature (base58). Short synthetic ids show whole. */
function shortSig(sig: string): string {
  return sig.length > 16 ? `${sig.slice(0, 6)}…${sig.slice(-6)}` : sig;
}

const num = (v: number | null, unit: string): string => (v == null ? "—" : `${Math.round(v)}${unit}`);

export function SendTxnsTable({ rows, emptyText }: { rows: Row[]; emptyText: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-muted p-3">{emptyText}</p>;
  }
  return (
    <div className="prov-table-wrap is-scroll" style={{ maxHeight: 560 }}>
      <table className="prov-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 980 }}>
        <colgroup>
          <col style={{ width: 150 }} />
          <col style={{ width: 130 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 90 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Signature</th>
            <th>Target</th>
            <th>Scenario</th>
            <th>Outcome</th>
            <th className="prov-num">Slot lat</th>
            <th className="prov-num">Wall</th>
            <th>Region</th>
            <th className="prov-num">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <a
                  href={`https://orbmarkets.io/tx/${r.signature}`}
                  target="_blank"
                  rel="noopener nofollow"
                  className="prov-ch-method"
                  style={{ color: "var(--text-2)" }}
                  title={r.signature}
                >
                  {shortSig(r.signature)}
                </a>
              </td>
              <td>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block w-[7px] h-[7px] rounded-full shrink-0"
                    style={{ background: colorFor(r.send_target) }}
                  />
                  <span className="text-[13px]">{targetLabel(r.send_target)}</span>
                </span>
              </td>
              <td className="text-[13px] text-fg2">{scenarioLabel(r.scenario)}</td>
              <td>
                <code style={{ fontSize: 11, color: OUTCOME_COLOR[r.outcome] ?? "var(--text-2)" }}>
                  {outcomeLabel(r.outcome)}
                </code>
              </td>
              <td className="prov-num">{num(r.slot_latency, " sl")}</td>
              <td className="prov-num">{num(r.wall_latency_ms, " ms")}</td>
              <td className="text-[12px] text-muted font-geistmono">{r.region}</td>
              <td className="prov-num prov-ch-when">{fmtRelativeTime(r.started_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
