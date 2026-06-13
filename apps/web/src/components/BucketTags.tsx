/**
 * Render a bucket name like 'large__program_heavy__versioned__archival'
 * as a row of color-coded chips. Each chip's color category, label, and the
 * hover `title` description all come from the shared glossary in
 * `bucketGlossary.ts` (the same source the BucketLegend explainer uses).
 *
 *   age/freshness    → cyan       recent, archival, last_hour, frozen, …
 *   size/shape       → violet     small, large, low, high, medium
 *   tx flavor        → amber      simple, program_heavy, legacy, versioned
 *   type/limit/other → neutral    program, token_account, processed, l100, …
 *
 * Per-chip explanations use a native `title` attribute (zero JS, instant,
 * accessible) rather than a portal tooltip — BucketTags renders many rows ×
 * several chips, so a portal per chip would be wasteful. The full categorized
 * legend lives in BucketLegend instead.
 */

import { resolveSegment, TAG_COLORS } from "./bucketGlossary";

export function BucketTags({ raw }: { raw: string }) {
  const parts = raw.split("__");
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {parts.map((p, i) => {
        const info = resolveSegment(p);
        const c = TAG_COLORS[info.category];
        return (
          <span
            key={`${i}-${p}`}
            title={info.description || undefined}
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 3,
              background: c.bg,
              color: c.fg,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              lineHeight: 1.4,
            }}
          >
            {info.label}
          </span>
        );
      })}
    </span>
  );
}
