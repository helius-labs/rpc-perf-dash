/**
 * Compact, read-only overall-score board for the Performance page, shown above
 * the chart's filter bar. Mirrors the Overview's overall-score ranking but is
 * computed from the page's already-fetched per-geo aggregates, so it tracks the
 * active chart filters (region / infra / window / connection / method). Weight
 * tuning stays on the Overview; this board is read-only at the default weighting.
 *
 * Visual language matches the Overview leaderboard: large display type where #1
 * dominates by scale and takes the provider's brand color (italic), the rest
 * smaller and muted, each score tinted by its tier color.
 *
 * No "use client" — pure presentational, rendered server-side so it re-runs on
 * every filter navigation.
 */

import { DEFAULT_WEIGHTS, type ScoringWeights } from "@rpcbench/shared/scoring";
import { scoreColor, type MiniScoreRow } from "@/components/leaderboardShared";
import { brandColorFor } from "@/lib/providerColors";

// Axis order + labels for the weights disclaimer (matches the Overview).
const WEIGHT_LABELS: ReadonlyArray<[keyof ScoringWeights, string]> = [
  ["latency", "Latency"],
  ["winRate", "Win rate"],
  ["reliability", "Reliability"],
  ["correctness", "Correctness"],
  ["freshness", "Freshness"],
];

const WEIGHT_SUMMARY = WEIGHT_LABELS.map(
  ([k, label]) => `${label} ${Math.round(DEFAULT_WEIGHTS[k] * 100)}%`,
).join(" · ");

// Pulsing fill for skeleton cells. Applied as the background of a span whose
// text is made transparent, so the pulsing rectangle is sized to the exact text
// metrics it stands in for — no layout shift when the real text swaps in.
const SKELETON_BG = "color-mix(in srgb, var(--text) 12%, transparent)";

// Placeholder rows for the very first load, before any real slice has been
// rendered (normally we skeleton over the retained rows instead, so widths match
// exactly). Names are mid-length so the fallback looks plausible.
const SKELETON_FALLBACK: MiniScoreRow[] = Array.from({ length: 6 }, (_, i) => ({
  provider_id: `skeleton-${i}`,
  provider_name: "Provider",
  total: 0,
}));

export function ScoreStrip({
  rows,
  ranked,
  methodCount = 1,
  loading = false,
}: {
  rows: MiniScoreRow[];
  ranked: boolean;
  /** Number of methods blended into this board (>1 → note it in the caption). */
  methodCount?: number;
  /** While true, render the board frame + caption but pulse the name/score cells
   *  (row count taken from the last data, or a sensible default) — so switching
   *  filters doesn't blank the whole leaderboard. */
  loading?: boolean;
}) {
  if (loading) {
    // Skeleton over the retained rows (or a fallback on first load) using the
    // IDENTICAL markup + text as the real board — only the text is made
    // transparent with a pulsing background behind it. Same rank numbers, same
    // row sizing, same caption, so the board doesn't reflow when data arrives.
    const skeletonRows = rows.length > 0 ? rows : SKELETON_FALLBACK;
    return (
      <div aria-busy="true">
        <ol
          className="flex flex-col gap-y-1"
          style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.03em", lineHeight: 1 }}
        >
          {skeletonRows.map((r, i) => {
            const leader = i === 0;
            // Include the "/100" suffix in the skeleton width so the row
            // doesn't reflow when the real (suffixed) score swaps in.
            const scoreText = r.total > 0 ? `${r.total.toFixed(1)}/100` : "—";
            return (
              <li
                key={r.provider_id}
                className={
                  "flex items-baseline justify-between gap-x-6 " +
                  (leader
                    ? "text-[clamp(22px,3.6vw,34px)] font-semibold"
                    : "text-[clamp(15px,2.4vw,20px)] font-normal")
                }
              >
                <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
                  <span className="font-geistmono text-[0.42em] tabular-nums text-muted">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={"rounded animate-pulse " + (leader ? "italic" : "")}
                    style={{ color: "transparent", backgroundColor: SKELETON_BG }}
                  >
                    {r.provider_name}
                  </span>
                </span>
                <span
                  className="tabular-nums shrink-0 rounded animate-pulse"
                  style={{ color: "transparent", backgroundColor: SKELETON_BG }}
                >
                  {scoreText}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 font-geistmono text-[9px] uppercase tracking-[0.08em] text-muted leading-snug">
          {methodCount > 1 ? `Blended across ${methodCount} methods · ` : ""}
          {WEIGHT_SUMMARY}
        </p>
      </div>
    );
  }

  if (!ranked) {
    return (
      <p className="text-[13px] text-fg2">
        Not enough samples to score at these filters yet.
      </p>
    );
  }

  return (
    <div>
      <ol
        className="flex flex-col gap-y-1"
        style={{ fontFamily: "var(--font-display)", letterSpacing: "-0.03em", lineHeight: 1 }}
      >
      {rows.map((r, i) => {
        const leader = i === 0;
        const eligible = r.total > 0;
        const nameColor = leader ? (brandColorFor(r.provider_id) ?? "var(--accent)") : undefined;
        return (
          <li
            key={r.provider_id}
            className={
              "flex items-baseline justify-between gap-x-6 " +
              (leader
                ? "text-[clamp(22px,3.6vw,34px)] font-semibold"
                : "text-[clamp(15px,2.4vw,20px)] font-normal")
            }
          >
            <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
              <span className="font-geistmono text-[0.42em] tabular-nums text-muted">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="inline-flex flex-col">
                <span
                  className={leader ? "italic" : "text-fg2"}
                  style={nameColor ? { color: nameColor } : undefined}
                >
                  {r.provider_name}
                </span>
                {!eligible && r.failing_reason ? (
                  <span className="font-geistmono text-[9px] not-italic uppercase tracking-[0.06em] text-muted leading-tight mt-0.5">
                    {r.failing_reason}
                  </span>
                ) : null}
              </span>
            </span>
            <span
              className="tabular-nums shrink-0"
              style={{ color: eligible ? scoreColor(r.total) : "var(--muted, #666)" }}
            >
              {eligible ? r.total.toFixed(1) : "—"}
              {eligible && (
                <i className="not-italic font-normal text-[0.34em] text-muted ml-[0.1em] align-baseline">
                  /100
                </i>
              )}
            </span>
          </li>
        );
      })}
      </ol>
      <p className="mt-2 font-geistmono text-[9px] uppercase tracking-[0.08em] text-muted leading-snug">
        {methodCount > 1 ? `Blended across ${methodCount} methods · ` : ""}
        {WEIGHT_SUMMARY}
      </p>
    </div>
  );
}
