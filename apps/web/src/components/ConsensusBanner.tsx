import type { ConsensusHealth } from "@/lib/health";

/**
 * Prominent banner shown when the benchmark panel has dropped below the
 * consensus voter minimum (fewer than MIN_CONSENSUS_VOTERS providers reporting).
 * In that state every method falls to `no_consensus` and the rankings silently
 * stop updating — this makes the cause obvious (which providers are down and
 * WHY) instead of leaving it buried in per-provider failure categories.
 *
 * Renders nothing when the panel is healthy, so it's safe to drop at the top of
 * any page.
 */
export function ConsensusBanner({ data }: { data: ConsensusHealth }) {
  if (!data.degraded) return null;
  const reasons = data.down.map((d) => `${d.name} (${d.reason})`).join(", ");
  return (
    <div
      className="badge bad"
      role="alert"
      style={{ display: "block", padding: "12px 14px", margin: "0 0 16px", lineHeight: 1.5 }}
    >
      <strong>Consensus degraded — {data.usable}/{data.total} providers reporting</strong>{" "}
      (rankings need ≥{data.minVoters}).{reasons ? ` Down: ${reasons}.` : ""} Rankings are
      paused until at least {data.minVoters} providers recover.
    </div>
  );
}
