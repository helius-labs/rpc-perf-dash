/**
 * Render a bucket name like 'large__program_heavy__versioned__archival'
 * as a row of color-coded chips.
 *
 *   age/freshness    → cyan       recent, archival, last_hour, last_24h, tip_minus_5,
 *                                 latest, shallow, deep, window
 *   size/shape       → violet     small, large, low, high, medium
 *   tx flavor        → amber      simple, program_heavy, legacy, versioned
 *   address/limit    → neutral    program, token_account, user_wallet, l10/l100/l1000
 */

const TAG_CLASS: Record<string, "age" | "size" | "flavor"> = {
  recent: "age",
  archival: "age",
  last_hour: "age",
  last_24h: "age",
  tip_minus_5: "age",
  latest: "age",
  shallow: "age",
  deep: "age",
  window: "age",
  small: "size",
  large: "size",
  low: "size",
  high: "size",
  medium: "size",
  simple: "flavor",
  program_heavy: "flavor",
  legacy: "flavor",
  versioned: "flavor",
};

const TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  age:     { bg: "#0e2230", fg: "#7cc6ff" },
  size:    { bg: "#1f1730", fg: "#c4adff" },
  flavor:  { bg: "#2a1f0e", fg: "#f3c27a" },
  default: { bg: "#1a1a1a", fg: "#aaa" },
};

function prettyTag(part: string): string {
  if (/^l\d+$/.test(part)) return `n=${part.slice(1)}`;
  if (part === "tip_minus_5") return "tip−5";
  return part.replace(/_/g, " ");
}

export function BucketTags({ raw }: { raw: string }) {
  const parts = raw.split("__");
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {parts.map((p, i) => {
        const cls = TAG_CLASS[p] ?? "default";
        const c = TAG_COLORS[cls] ?? TAG_COLORS.default!;
        return (
          <span
            key={`${i}-${p}`}
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
            {prettyTag(p)}
          </span>
        );
      })}
    </span>
  );
}
