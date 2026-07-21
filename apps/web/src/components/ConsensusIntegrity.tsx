import { FloatingTooltip } from "@/components/FloatingTooltip";
import type { ConsensusRate } from "@/lib/consensus";

/**
 * Consensus integrity — daily no-consensus rate over the last 14 days. Sampled
 * via consensus_log so totals are a slice of traffic, not the full population —
 * ratios still meaningful. Rendered at the bottom of the /status page.
 */
export function ConsensusIntegrity({
  rates,
}: {
  rates: ConsensusRate[];
}) {
  return (
    <section className="home-extra">
      <div className="prov-section">
        <div className="prov-section-head">
          <span className="section-kicker">Consensus integrity · 14d</span>
        </div>
        {rates.length === 0 ? (
          <p className="prov-empty">No consensus_log entries yet.</p>
        ) : (
          <div className="prov-table-wrap is-scroll">
            <table className="prov-table">
              <thead>
                <tr>
                  <th>
                    <FloatingTooltip
                      title="Day"
                      trigger={
                        <span className="border-b border-dotted border-current cursor-help">Day</span>
                      }
                    >
                      <div className="font-medium mb-1.5">Day</div>
                      <div className="text-neutral-400">
                        Calendar day (UTC) the consensus decisions were finalized, most
                        recent first. The table covers the last 14 days.
                      </div>
                    </FloatingTooltip>
                  </th>
                  <th className="prov-num">
                    <FloatingTooltip
                      title="Sampled"
                      trigger={
                        <span className="border-b border-dotted border-current cursor-help">Sampled</span>
                      }
                    >
                      <div className="font-medium mb-1.5">Sampled</div>
                      <div className="text-neutral-400">
                        Consensus-log entries recorded that day. Logging is selective
                        (every no-consensus challenge plus a 1% sample of clean archive
                        traffic), so this is a <strong>slice</strong> of all challenges,
                        not the full population. The percentages stay meaningful; the
                        absolute counts do not.
                      </div>
                    </FloatingTooltip>
                  </th>
                  <th className="prov-num">
                    <FloatingTooltip
                      title="No-consensus"
                      trigger={
                        <span className="border-b border-dotted border-current cursor-help">No-consensus</span>
                      }
                    >
                      <div className="font-medium mb-1.5">No-consensus</div>
                      <div className="text-neutral-400">
                        The benchmarked-provider panel couldn&apos;t agree on a single
                        correct answer (decision = <code>ambiguous</code>). These
                        challenges are dropped from scoring. Lower is better.
                      </div>
                    </FloatingTooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.day}>
                    <td className="prov-amb-day">{r.day}</td>
                    <td className="prov-num">{r.total.toLocaleString()}</td>
                    <td className="prov-num">
                      {r.no_consensus.toLocaleString()}
                      {r.total > 0 && (
                        <span className="text-muted ml-1">
                          ({((r.no_consensus / r.total) * 100).toFixed(1)}%)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
