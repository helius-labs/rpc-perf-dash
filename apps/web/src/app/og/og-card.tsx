/**
 * The 1200×630 share card, as Satori-safe JSX (consumed by the /og/leaderboard
 * route's ImageResponse). Pure presentational function — no hooks, no client
 * APIs — so it renders inside the OG runtime. Satori only supports flexbox, so
 * every multi-child element sets display:flex explicitly and there are no grids.
 *
 * Visual tokens mirror the live dark theme (globals.css): bg #0A0B0E, surfaces
 * #11131A/#161922, borders #1F2129, text #F2F1ED / muted #B6B5AE / #6E6D67,
 * accent #F46036. Winner name/score is tinted with the provider's brand color.
 */

const BG = "#0A0B0E";
const SURFACE = "#13151D";
const BORDER = "#23262F";
const TRACK = "#1C1F28";
const TEXT = "#F2F1ED";
const MUTED = "#B6B5AE";
const FAINT = "#6E6D67";
const ACCENT = "#F46036";

const SANS = "Geist";
const MONO = "Geist Mono";

export interface CardRow {
  provider_id: string;
  provider_name: string;
  /** 0–100 composite. */
  total: number;
  p50_ms: number | null;
  /** 0–1. */
  win_rate: number;
  /** Brand color for the name/score tint, or null. */
  brand: string | null;
  /** Chart color for the score bar / dot fallback. */
  color: string;
  /** base64 data URI for the logo mark, or null → initial chip. */
  logo: string | null;
  eligible: boolean;
}

export interface CardProps {
  rows: CardRow[];
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
        color: "#0A0B0E",
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

// Fixed column widths so every row's score bar shares the same left/right edges
// (the bar lives between a fixed left block and a fixed score column).
const LEFT_W = 430;
const SCORE_W = 104;
const BAR_H = 10;

/** A single leaderboard row. #1 gets a tinted band, brand accent bar, and larger type. */
function Row({ row, rank }: { row: CardRow; rank: number }) {
  const first = rank === 1;
  const accent = row.brand ?? (first ? ACCENT : TEXT);
  // Bar fills to the absolute score (0–100), so the leader isn't a flat full bar.
  const barPct = Math.max(3, Math.min(100, row.total));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: first ? 104 : 78,
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
            {row.p50_ms == null
              ? `${fmtPct(row.win_rate)} win`
              : `${fmtP50(row.p50_ms)} p50 · ${fmtPct(row.win_rate)} win`}
          </span>
        </div>
      </div>

      {/* Score bar — same height + horizontal extent on every row */}
      <div style={{ display: "flex", flex: 1, height: BAR_H, background: TRACK, borderRadius: 999, marginRight: 24 }}>
        <div style={{ display: "flex", width: `${barPct}%`, height: BAR_H, background: row.color, borderRadius: 999 }} />
      </div>

      {/* Score */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", width: SCORE_W }}>
        <span style={{ fontFamily: SANS, fontSize: first ? 56 : 34, fontWeight: 600, color: first ? accent : TEXT, lineHeight: 1 }}>
          {Math.round(row.total)}
        </span>
      </div>
    </div>
  );
}

export function LeaderboardCard(props: CardProps) {
  const { rows, method, methodsLabel, regionLabel, contextLabel, timestamp, siteUrl } = props;
  const ranked = rows.slice(0, 4);

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
        <div style={{ display: "flex", flexDirection: "column", marginTop: 22 }}>
          {ranked.map((r, i) => (
            <Row key={r.provider_id} row={r} rank={i + 1} />
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", marginTop: 28, fontFamily: SANS, fontSize: 22, color: MUTED }}>
          No eligible providers for this view yet.
        </div>
      )}

      {/* Footer — host only */}
      <div style={{ display: "flex", alignItems: "center", marginTop: "auto", paddingTop: 18 }}>
        <span style={{ display: "flex", fontFamily: MONO, fontSize: 15, color: FAINT, letterSpacing: "0.04em" }}>
          {siteUrl}
        </span>
      </div>
    </div>
  );
}
