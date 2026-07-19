/**
 * Shared in-SVG hover tooltip — the single source of truth for the chart
 * tooltip look (box, fonts, sizing, row layout). Used by both the time-series
 * LatencyChart and the latency-distribution charts so they stay identical.
 *
 * Pure presentational (no hooks/state) — the caller owns positioning + when to
 * render it. Coordinates are in the parent SVG's viewBox space.
 */

export interface SvgTooltipRow {
  key: string;
  /** Left label (provider name, percentile name, …). */
  label: string;
  /** Right value (monospace). */
  value: string;
  /** Optional color swatch before the label. */
  color?: string;
  /** Bright + bold (the highlighted/nearest row). */
  emphasized?: boolean;
  /** Fade the swatch (a non-nearest row). */
  dimmed?: boolean;
}

export const TOOLTIP_W = 200;
/** Box height for n rows — matches the row layout below. */
export function svgTooltipHeight(rows: number): number {
  return 24 + rows * 16;
}

export function SvgChartTooltip({
  x,
  y,
  width = TOOLTIP_W,
  header,
  rows,
}: {
  x: number;
  y: number;
  width?: number;
  header: string;
  rows: SvgTooltipRow[];
}) {
  return (
    <g transform={`translate(${x}, ${y})`} pointerEvents="none">
      <rect x={0} y={0} width={width} height={svgTooltipHeight(rows.length)} fill="#1a1a1a" stroke="#444" strokeWidth={1} rx={3} />
      <text x={8} y={15} fill="#ddd" fontSize={11} fontFamily="system-ui, sans-serif">
        {header}
      </text>
      {rows.map((r, i) => (
        <g key={r.key} transform={`translate(8, ${30 + i * 16})`}>
          {r.color && <rect x={0} y={-8} width={10} height={10} fill={r.color} rx={2} opacity={r.dimmed ? 0.55 : 1} />}
          <text
            x={r.color ? 16 : 0}
            y={0}
            fill={r.emphasized ? "#fff" : "#999"}
            fontSize={11}
            fontWeight={r.emphasized ? 600 : 400}
            fontFamily="system-ui, sans-serif"
          >
            {r.label}
          </text>
          <text
            // Rows are inside a g translated by +8, so width-16 lands the
            // right-anchored value 8 units from the box edge — symmetric with
            // the 8-unit left padding.
            x={width - 16}
            y={0}
            fill={r.emphasized ? "#fff" : "#999"}
            fontSize={11}
            fontWeight={r.emphasized ? 600 : 400}
            textAnchor="end"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {r.value}
          </text>
        </g>
      ))}
    </g>
  );
}
