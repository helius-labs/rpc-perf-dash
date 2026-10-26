import type { ConsensusHealth } from "@/lib/health";
import { formatAsOf } from "@/lib/formatAsOf";

/** The oldest window end in a providerAsOf map, formatted; null when empty. */
function oldestAsOf(providerAsOf: Record<string, string>): string | null {
  const ends = Object.values(providerAsOf).sort();
  return ends[0] ? formatAsOf(ends[0]) : null;
}

/**
 * Prominent banner shown when the benchmark panel has dropped below the
 * consensus voter minimum (fewer than MIN_CONSENSUS_VOTERS providers reporting).
 * In that state every method falls to `no_consensus` and the rankings silently
 * stop updating — this makes the cause obvious (which providers are down and
 * WHY) instead of leaving it buried in per-provider failure categories.
 *
 * `providerAsOf` (from buildOverviewBoardData) lists the providers the board
 * below shows from their own last window that ranked, not the live one; the
 * banner says so, including during the recovery hours when consensus is back
 * but the live window hasn't re-qualified yet. Each row carries its own
 * "last updated" time.
 *
 * Renders nothing when the panel is healthy and the board is live, so it's
 * safe to drop at the top of any page.
 */
export function ConsensusBanner({
  data,
  providerAsOf = {},
}: {
  data: ConsensusHealth;
  providerAsOf?: Record<string, string>;
}) {
  const staleCount = Object.keys(providerAsOf).length;
  if (!data.degraded && staleCount === 0) return null;
  const reasons = data.down.map((d) => `${d.name} (${d.reason})`).join(", ");
  const staleNote =
    "shown with their most recent valid results, marked \u201clast updated\u201d on each row";
  // Rows from different dates were scored against different panels (see
  // methodology § "When a provider is down").
  const mixNote = " Rows from different dates competed against different panels, so compare them loosely.";

  if (!data.degraded) {
    return (
      <div
        className="badge warn"
        role="status"
        style={{ display: "block", padding: "12px 14px", margin: "0 0 16px", lineHeight: 1.5 }}
      >
        <strong>
          {staleCount} provider{staleCount === 1 ? " has" : "s have"} no live ranking yet.
        </strong>{" "}
        {staleCount === 1 ? "It's" : "They're"} {staleNote}, until the live window has enough
        samples again.{mixNote}
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
      {staleCount > 0
        ? `Providers without live rankings are ${staleNote}, until at least ${data.minVoters} providers recover.${mixNote}`
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
export function StaleNotice({ providerAsOf }: { providerAsOf: Record<string, string> }) {
  const oldest = oldestAsOf(providerAsOf);
  if (!oldest) return null;
  return (
    <div
      className="badge warn"
      role="status"
      style={{ display: "block", padding: "6px 10px", margin: "0 0 8px", fontSize: 12, lineHeight: 1.4 }}
    >
      Live rankings paused for some providers (too few reporting). They&apos;re shown with their
      most recent valid results, the oldest ending {oldest}. Rows from different dates competed
      against different panels, so compare them loosely.
    </div>
  );
}
