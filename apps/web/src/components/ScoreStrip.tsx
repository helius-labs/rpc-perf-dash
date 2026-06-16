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

export function ScoreStrip({
  rows,
  ranked,
}: {
  rows: MiniScoreRow[];
  ranked: boolean;
}) {
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
              <span
                className={leader ? "italic" : "text-fg2"}
                style={nameColor ? { color: nameColor } : undefined}
              >
                {r.provider_name}
              </span>
            </span>
            <span
              className="tabular-nums shrink-0"
              style={{ color: eligible ? scoreColor(r.total) : "var(--muted, #666)" }}
            >
              {eligible ? r.total.toFixed(1) : "—"}
            </span>
          </li>
        );
      })}
      </ol>
      <p className="mt-2 font-geistmono text-[9px] uppercase tracking-[0.08em] text-muted leading-snug">
        {WEIGHT_SUMMARY}
      </p>
    </div>
  );
}
