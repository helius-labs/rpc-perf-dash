import type { ConsensusHealth } from "@/lib/health";

/** "Oct 18, 14:00 UTC" — the stale window's end, shown in UTC so every viewer
 *  reads the same instant. */
function formatStaleAsOf(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}

/**
 * Prominent banner shown when the benchmark panel has dropped below the
 * consensus voter minimum (fewer than MIN_CONSENSUS_VOTERS providers reporting).
 * In that state every method falls to `no_consensus` and the rankings silently
 * stop updating — this makes the cause obvious (which providers are down and
 * WHY) instead of leaving it buried in per-provider failure categories.
 *
 * `staleAsOf` (from buildOverviewBoardData) means the board below is the last
 * window that ranked, not the live one; the banner says so, including during
 * the recovery hours when consensus is back but the live window hasn't
 * re-qualified yet.
 *
 * Renders nothing when the panel is healthy and the board is live, so it's
 * safe to drop at the top of any page.
 */
export function ConsensusBanner({
  data,
  staleAsOf = null,
}: {
  data: ConsensusHealth;
  staleAsOf?: string | null;
}) {
  if (!data.degraded && !staleAsOf) return null;
  const reasons = data.down.map((d) => `${d.name} (${d.reason})`).join(", ");
  const asOf = staleAsOf ? formatStaleAsOf(staleAsOf) : null;

  if (!data.degraded) {
    return (
      <div
        className="badge warn"
        role="status"
        style={{ display: "block", padding: "12px 14px", margin: "0 0 16px", lineHeight: 1.5 }}
      >
        <strong>Live rankings are rebuilding</strong> after a consensus outage. Showing the last
        complete rankings, ending {asOf}, until the live window has enough samples again.
      </div>
    );
  }

  return (
    <div
      className="badge bad"
      role="alert"
      style={{ display: "block", padding: "12px 14px", margin: "0 0 16px", lineHeight: 1.5 }}
    >
      <strong>Consensus degraded — {data.usable}/{data.total} providers reporting</strong>{" "}
      (rankings need ≥{data.minVoters}).{reasons ? ` Down: ${reasons}.` : ""}{" "}
      {asOf
        ? `Showing the last complete rankings, ending ${asOf}, until at least ${data.minVoters} providers recover.`
        : `Rankings are paused until at least ${data.minVoters} providers recover.`}
    </div>
  );
}

/**
 * Compact stale-data label for the embeds. They have no ConsensusBanner (no
 * consensus-health fetch, little room), but they get the same fallback cube from
 * buildOverviewBoardData, so without this a third-party page would present
 * day-old rankings as current. Renders nothing when the data is live.
 */
export function StaleNotice({ staleAsOf }: { staleAsOf: string | null }) {
  if (!staleAsOf) return null;
  return (
    <div
      className="badge warn"
      role="status"
      style={{ display: "block", padding: "6px 10px", margin: "0 0 8px", fontSize: 12, lineHeight: 1.4 }}
    >
      Live rankings paused (too few providers reporting). Showing the last complete rankings,
      ending {formatStaleAsOf(staleAsOf)}.
    </div>
  );
}
