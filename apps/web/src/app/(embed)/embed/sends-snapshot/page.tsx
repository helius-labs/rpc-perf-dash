import type { Route } from "next";
import Link from "next/link";
import { SendsLeaderboard } from "@/components/SendsLeaderboard";
import { SENDS_SNAPSHOT } from "@/lib/sendsSnapshot";

// The whole point of this widget: no DB, no request-time data. It renders a
// checked-in file, so it is prerendered once at build and served as static
// output. Contrast every other /embed/* route, which is force-dynamic.
export const dynamic = "force-static";

/** "2026-09-15" → "Sep 15, 2026". Parsed as UTC to match the stamp's origin. */
function formatAsOf(iso: string): string | null {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Embeddable STATIC send leaderboard — a dated snapshot, not a live view.
 *
 * Exists because the live board moves: the top two targets can sit within a
 * fraction of a slot of each other, so a live embed on a landing page reorders
 * for reasons that aren't a change in anyone's service. This freezes one
 * published set of numbers until someone lands a new one.
 *
 * That only stays honest if the card says what it is, so two things below are
 * load-bearing and shouldn't be "cleaned up": the visible `asOf` date, and the
 * link to the live board. A snapshot nobody refreshes then reads as an old
 * result — which it is — instead of as a current claim.
 */
export default function EmbedSendsSnapshotPage() {
  const { asOf, rows, grain } = SENDS_SNAPSHOT;
  const stamped = asOf ? formatAsOf(asOf) : null;

  // No rows, or a date we can't render, means no publishable snapshot — say so
  // rather than showing a headless list of numbers with nothing dating them.
  if (rows.length === 0 || !stamped) {
    return (
      <div className="badge" style={{ display: "block", padding: 12 }}>
        Snapshot not yet published — run <code>pnpm snapshot:sends --write</code> and deploy.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-fg">Transaction landing benchmark</h2>
        <span className="font-geistmono text-[10px] uppercase tracking-[0.08em] text-muted">
          snapshot
        </span>
      </div>

      <SendsLeaderboard rows={rows} />

      <p className="mt-2.5 text-[11px] text-muted">
        {grain === "1d" ? "24-hour" : "1-hour"} window, as of {stamped} ·{" "}
        <Link href={"/sends" as Route} target="_top" className="text-muted hover:text-fg">
          live results →
        </Link>
      </p>
    </div>
  );
}
