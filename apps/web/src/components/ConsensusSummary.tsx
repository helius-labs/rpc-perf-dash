/**
 * Per-challenge consensus summary chip.
 *
 * Compact, color-only format: each non-zero outcome count is rendered in
 * its semantic color, joined by faint middots. Color carries the meaning
 * (green=correct, amber=ambiguous, red=incorrect) — same palette as the
 * column-header tooltip's legend. Zero counts are hidden to minimize noise.
 *
 *   24            ← all correct
 *   24 · 2        ← green correct · red incorrect
 *   12 · 5        ← green correct · amber ambiguous
 *   20 · 3 · 1    ← green · amber · red
 *   —             ← no samples yet
 *
 * Hover title carries the full breakdown including the disputed sub-count.
 */

import type { ReactNode } from "react";

export interface ConsensusCounts {
  total: number;
  correct: number;
  ambiguous: number;
  incorrect: number;
  /** subset of `ambiguous` with exclusion_reason='consensus_disputed' */
  disputed: number;
}

const CLR = {
  correct: "#7be0a4",
  ambiguous: "#f3c27a",
  incorrect: "#f08080",
  empty: "#555",
  sep: "#3a3a3a",
} as const;

const BASE_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontVariantNumeric: "tabular-nums",
};

export function ConsensusSummary({ counts }: { counts: ConsensusCounts }) {
  if (counts.total === 0) {
    return (
      <span
        title="No samples yet. The challenge was just dispatched, or no vantages claimed an assignment."
        style={{ ...BASE_STYLE, color: CLR.empty }}
      >
        —
      </span>
    );
  }

  const segments: Array<{ n: number; color: string }> = [];
  if (counts.correct > 0) segments.push({ n: counts.correct, color: CLR.correct });
  if (counts.ambiguous > 0) segments.push({ n: counts.ambiguous, color: CLR.ambiguous });
  if (counts.incorrect > 0) segments.push({ n: counts.incorrect, color: CLR.incorrect });

  const title =
    `${counts.total} samples · ` +
    `${counts.correct} correct · ` +
    `${counts.ambiguous} ambiguous` +
    (counts.disputed > 0 ? ` (incl. ${counts.disputed} auditor-disputed)` : "") +
    ` · ${counts.incorrect} incorrect`;

  const children: ReactNode[] = [];
  segments.forEach((s, i) => {
    if (i > 0) {
      children.push(
        <span key={`sep-${i}`} style={{ color: CLR.sep, margin: "0 5px" }}>
          ·
        </span>,
      );
    }
    children.push(
      <span key={`n-${i}`} style={{ color: s.color }}>
        {s.n}
      </span>,
    );
  });

  return (
    <span title={title} style={BASE_STYLE}>
      {children}
    </span>
  );
}
