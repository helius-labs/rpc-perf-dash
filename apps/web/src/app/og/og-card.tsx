/**
 * The 1200×630 share card, as Satori-safe JSX (consumed by the /og/leaderboard
 * route's ImageResponse). Pure presentational function — no hooks, no client
 * APIs — so it renders inside the OG runtime. Satori only supports flexbox, so
 * every multi-child element sets display:flex explicitly and there are no grids.
 *
 * Visual tokens mirror the live dark theme (globals.css): bg #000000, surfaces
 * #0C0C0E/#141416, borders #1B1B1E/#262629, text #F4F4F2 / muted #B0B0AE / #6A6A68,
 * near-white accent #E5E5E5. Winner name/score is tinted with the provider's
 * brand color.
 */

const BG = "#000000";
const SURFACE = "#101012";
const BORDER = "#262629";
const TRACK = "#1A1A1C";
const TEXT = "#F4F4F2";
const MUTED = "#B0B0AE";
const FAINT = "#6A6A68";
const ACCENT = "#E5E5E5";

const SANS = "Geist";
const MONO = "Geist Mono";

export interface CardRow {
  provider_id: string;
  provider_name: string;
  /** 0–100 composite. Unused (placeholder) on latency cards. */
  total: number;
  p50_ms: number | null;
  p95_ms: number | null;
  /** 0–1. Unused (placeholder) on latency cards. */
  win_rate: number;
  /** Brand color for the name/score tint, or null. */
  brand: string | null;
  /** Chart color for the score bar / dot fallback. */
  color: string;
  /** base64 data URI for the logo mark, or null → initial chip. */
  logo: string | null;
  eligible: boolean;
  /** Optional pre-formatted sub-line (e.g. sends: "98% land · 2 slot"). When set
   *  it replaces the default win/p50 line — lets the sends card reuse this card
   *  with send-correct labels instead of RPC's "win / p50 ms". */
  subtitle?: string;
}

export interface CardProps {
  rows: CardRow[];
  /** "score" (default) ranks by the 0–100 composite; "latency" ranks by ms. */
  metric?: "score" | "latency";
  /** Latency percentile shown as the primary number on a latency card. */
  stat?: "p50" | "p95";
  method: string;
  /** The blended methods for a preset card — names if few, else "N methods".
   *  Omitted for single-method/region cards (the header already names it). */
  methodsLabel?: string;
  /** Region the measurement covers, e.g. "Overall (all regions)" or "NA East". */
  regionLabel: string;
  /** e.g. "cold start · last 24h" */
  contextLabel: string;
  /** e.g. "AS OF JUN 16 2026 · 14:30 UTC" */
  timestamp: string;
  siteUrl: string;
}

/** Provider mark: logo image if available, else a brand-tinted initial chip. */
function Mark({ row, size }: { row: CardRow; size: number }) {
  if (row.logo) {
    return (
      <img
        src={row.logo}
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "contain" }}
      />
    );
  }
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: row.color,
        color: "#000000",
        fontFamily: SANS,
        fontWeight: 600,
        fontSize: size * 0.5,
      }}
    >
      {row.provider_name.charAt(0)}
    </div>
  );
}

function fmtP50(ms: number | null): string {
  return ms == null ? "—" : `${Math.round(ms)} ms`;
}
function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** The latency value for the primary stat, and the other percentile's label. */
function latencyOf(row: CardRow, stat: "p50" | "p95"): number | null {
  return stat === "p95" ? row.p95_ms : row.p50_ms;
}
function otherLatencyLabel(row: CardRow, stat: "p50" | "p95"): string {
  return stat === "p95" ? `${fmtP50(row.p50_ms)} p50` : `${fmtP50(row.p95_ms)} p95`;
}

// Fixed column widths so every row's score bar shares the same left/right edges
// (the bar lives between a fixed left block and a fixed score column).
const LEFT_W = 430;
const SCORE_W = 104;
const BAR_H = 10;

/** A single leaderboard row. #1 gets a tinted band, brand accent bar, and larger type. */
function Row({
  row,
  rank,
  metric,
  stat,
  fastest,
}: {
  row: CardRow;
  rank: number;
  metric: "score" | "latency";
  stat: "p50" | "p95";
  /** Fastest (min) latency across shown rows — sets the full-bar reference. */
  fastest: number | null;
}) {
  const first = rank === 1;
  const accent = row.brand ?? (first ? ACCENT : TEXT);
  const isLatency = metric === "latency";
  const latency = latencyOf(row, stat);
  // Score cards: bar fills to the absolute score (0–100). Latency cards: bar is
  // relative speed — fastest provider is full, slower ones proportionally shorter
  // (fastest / thisLatency), so the leader isn't a flat full bar either way.
  const barPct = isLatency
    ? latency && fastest
      ? Math.max(3, Math.min(100, (fastest / latency) * 100))
      : 3
    : Math.max(3, Math.min(100, row.total));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: first ? 92 : 70,
        padding: "0 26px",
        borderRadius: first ? 16 : 0,
        background: first ? SURFACE : "transparent",
        borderBottom: first ? "none" : `1px solid ${BORDER}`,
      }}
    >
      {/* Left block — fixed width so the bar starts at the same x on every row */}
      <div style={{ display: "flex", alignItems: "center", width: LEFT_W }}>
        {first ? (
          <div style={{ display: "flex", width: 4, height: 56, borderRadius: 999, background: accent, marginRight: 16 }} />
        ) : null}
        <div
          style={{
            display: "flex",
            fontFamily: MONO,
            fontSize: first ? 24 : 18,
            fontWeight: first ? 600 : 400,
            color: first ? accent : FAINT,
            width: first ? 40 : 48,
          }}
        >
          {`#${rank}`}
        </div>
        <Mark row={row} size={first ? 56 : 38} />
        <div style={{ display: "flex", flexDirection: "column", marginLeft: first ? 20 : 18, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontFamily: SANS,
              fontSize: first ? 38 : 26,
              fontWeight: 600,
              color: first ? accent : TEXT,
              lineHeight: 1.05,
            }}
          >
            {row.provider_name}
          </span>
          <span style={{ display: "flex", fontFamily: MONO, fontSize: first ? 16 : 14, color: MUTED, marginTop: 6 }}>
            {row.subtitle
              ? row.subtitle
              : isLatency
                ? otherLatencyLabel(row, stat)
                : row.p50_ms == null
                  ? `${fmtPct(row.win_rate)} win`
                  : `${fmtP50(row.p50_ms)} p50 · ${fmtPct(row.win_rate)} win`}
          </span>
        </div>
      </div>

      {/* Score bar — same height + horizontal extent on every row */}
      <div style={{ display: "flex", flex: 1, height: BAR_H, background: TRACK, borderRadius: 999, marginRight: 24 }}>
        <div style={{ display: "flex", width: `${barPct}%`, height: BAR_H, background: row.color, borderRadius: 999 }} />
      </div>

      {/* Primary metric — composite score, or the chosen latency percentile (ms) */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", width: SCORE_W }}>
        {isLatency ? (
          <>
            <span style={{ fontFamily: SANS, fontSize: first ? 44 : 30, fontWeight: 600, color: first ? accent : TEXT, lineHeight: 1 }}>
              {latency == null ? "—" : Math.round(latency)}
            </span>
            {latency != null ? (
              <span style={{ fontFamily: MONO, fontSize: first ? 16 : 13, color: MUTED, marginLeft: 4 }}>ms</span>
            ) : null}
          </>
        ) : (
          <span style={{ fontFamily: SANS, fontSize: first ? 56 : 34, fontWeight: 600, color: first ? accent : TEXT, lineHeight: 1 }}>
            {Math.round(row.total)}
          </span>
        )}
      </div>
    </div>
  );
}

export function LeaderboardCard(props: CardProps) {
  const { rows, method, methodsLabel, regionLabel, contextLabel, timestamp, siteUrl } = props;
  const metric = props.metric ?? "score";
  const stat = props.stat ?? "p50";
  // Fixed at 4 regardless of provider count — the fixed 1200×630 canvas has no
  // room for a 5th row (see Row's height values above). A 5th-ranked provider
  // is intentionally omitted from share cards, not a bug.
  const ranked = rows.slice(0, 4);
  // Latency bars are relative to the fastest shown provider (full bar = fastest).
  const fastest =
    metric === "latency"
      ? ranked.reduce<number | null>((min, r) => {
          const v = latencyOf(r, stat);
          return v == null ? min : min == null ? v : Math.min(min, v);
        }, null)
      : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: BG,
        padding: "46px 56px",
        position: "relative",
        fontFamily: SANS,
      }}
    >
      {/* Top accent hairline */}
      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 6, background: ACCENT }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", fontFamily: MONO, fontSize: 22, fontWeight: 500 }}>
          <span style={{ color: ACCENT }}>[</span>
          <span style={{ color: TEXT, padding: "0 8px" }}>Solana RPC Benchmark</span>
          <span style={{ color: ACCENT }}>]</span>
        </div>
        <div style={{ display: "flex", fontFamily: MONO, fontSize: 15, color: FAINT, letterSpacing: "0.08em" }}>
          {timestamp}
        </div>
      </div>

      {/* Method + scope — clean typographic hierarchy, no pills */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ fontFamily: MONO, fontSize: 46, fontWeight: 500, color: TEXT }}>{method}</span>
        </div>
        {methodsLabel ? (
          <div style={{ display: "flex", marginTop: 8, fontFamily: MONO, fontSize: 16, color: FAINT }}>
            {methodsLabel}
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", marginTop: 12, fontFamily: SANS, fontSize: 21, color: MUTED }}>
          <span style={{ color: TEXT, fontWeight: 500 }}>{regionLabel}</span>
          <span style={{ color: FAINT, padding: "0 10px" }}>·</span>
          <span>{contextLabel}</span>
        </div>
      </div>

      {/* Leaderboard */}
      {ranked.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", marginTop: 16 }}>
          {ranked.map((r, i) => (
            <Row key={r.provider_id} row={r} rank={i + 1} metric={metric} stat={stat} fastest={fastest} />
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", marginTop: 28, fontFamily: SANS, fontSize: 22, color: MUTED }}>
          No eligible providers for this view yet.
        </div>
      )}

      {/* Footer — host only */}
      <div style={{ display: "flex", alignItems: "center", marginTop: "auto", paddingTop: 14 }}>
        <span style={{ display: "flex", fontFamily: MONO, fontSize: 15, color: FAINT, letterSpacing: "0.04em" }}>
          {siteUrl}
        </span>
      </div>
    </div>
  );
}
