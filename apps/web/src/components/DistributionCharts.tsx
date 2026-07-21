"use client";

/**
 * Latency-distribution chart primitives — three interactive SVG views of a
 * per-provider latency distribution, rendered from the same `DistributionSeries`:
 *
 *   1. CdfChart      — cumulative (% of requests ≤ x ms). Hover shows a
 *                      crosshair, dims all but the nearest line, and a tooltip
 *                      with the latency + each provider's % of requests.
 *   2. DensityChart  — log-x histogram with a shared "share of requests"
 *                      y-axis. Hover shows the bucket latency + each provider's
 *                      share in that bucket.
 *   3. BoxChart      — p25–p75 box, whisker→p95, p99 dot, min tick, with the
 *                      provider name in a left gutter. Hover an individual
 *                      marker (min / p25 / p50 / p75 / p95 / p99) for just that
 *                      percentile's value.
 *
 * The hover tooltip is the shared <SvgChartTooltip>, identical to the
 * time-series LatencyChart. Data comes from `fetchLatencyDistribution`.
 */
import { useRef, useState } from "react";
import { LATENCY_HIST, latencyBinCenter } from "@rpcbench/shared/histogram";
import { SvgChartTooltip, svgTooltipHeight, TOOLTIP_W, type SvgTooltipRow } from "./SvgChartTooltip";

// ---- shared log-x scale + layout (module scope) --------------------------

const W = 860;
const PAD_L = 56;
const PAD_R = 16;
const INNER_W = W - PAD_L - PAD_R;
const XMIN = 3;
const XMAX = 2000;
const TICKS = [3, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];
const LOG_MIN = Math.log(XMIN);
const LOG_SPAN = Math.log(XMAX) - LOG_MIN;

/** ms → x pixel on the fixed log scale [3, 2000]. */
function lx(v: number): number {
  const c = Math.min(XMAX, Math.max(XMIN, v));
  return PAD_L + ((Math.log(c) - LOG_MIN) / LOG_SPAN) * INNER_W;
}
/** x pixel → ms (inverse of lx), for hover. */
function invLx(x: number): number {
  const frac = (x - PAD_L) / INNER_W;
  return Math.exp(LOG_MIN + Math.min(1, Math.max(0, frac)) * LOG_SPAN);
}

// Histogram bin domain is shared with the generator (packages/shared) so the
// stored bins are interpreted on the exact same scale they were written.
const { L0, L1, NBINS } = LATENCY_HIST;
const BIN_STEP = (L1 - L0) / NBINS;
const binCenter = latencyBinCenter;
/** Histogram bucket (1..NBINS) a latency falls in. */
function bucketOf(v: number): number {
  return Math.min(NBINS, Math.max(1, Math.floor((Math.log(Math.max(1, v)) - L0) / BIN_STEP) + 1));
}

const AXIS_COLOR = "#3a3f49";
const GRID_COLOR = "#171a20";
const LABEL_COLOR = "#8b919d";

// ---- series shape --------------------------------------------------------

export interface DistributionSeries {
  id: string;
  name: string;
  color: string;
  n: number;
  /** 101 percentile latencies (p0..p100). */
  q: number[];
  p50: number;
  p95: number;
  min: number;
  p25: number;
  p75: number;
  p99: number;
  hist: { bucket: number; cnt: number }[];
  histMax: number;
  winPct: number;
}

interface ChartProps {
  series: DistributionSeries[];
}

// ---- shared helpers ------------------------------------------------------

/** Map a mouse event to viewBox coords (the SVG is width:100%, viewBox 0 0 W H). */
function svgCoords(svg: SVGSVGElement, clientX: number, clientY: number, h: number) {
  const r = svg.getBoundingClientRect();
  return {
    x: ((clientX - r.left) / r.width) * W,
    y: ((clientY - r.top) / r.height) * h,
  };
}

// These charts use an 860-wide viewBox while the time-series LatencyChart uses
// 1280; both render at width:100%, so an unscaled shared tooltip would appear
// ~1.49× larger here. Scale it by 860/1280 so it renders at the same on-screen
// size as the latency chart's tooltip.
const TIP_SCALE = W / 1280;

/** Positioned shared tooltip: scaled to match the latency chart, and clamped to
 *  stay inside the [0,W]×[0,chartH] box (using the scaled footprint). */
function PositionedTip({ ax, ay, chartH, header, rows }: { ax: number; ay: number; chartH: number; header: string; rows: SvgTooltipRow[] }) {
  const w = TOOLTIP_W * TIP_SCALE;
  const h = svgTooltipHeight(rows.length) * TIP_SCALE;
  let tx = ax + 12;
  if (tx + w > W - 6) tx = ax - 12 - w;
  tx = Math.min(W - 6 - w, Math.max(6, tx));
  const ty = Math.min(chartH - h - 4, Math.max(4, ay - h / 2));
  return (
    <g transform={`translate(${tx}, ${ty}) scale(${TIP_SCALE})`}>
      <SvgChartTooltip x={0} y={0} header={header} rows={rows} />
    </g>
  );
}

function XAxis({ y }: { y: number }) {
  return (
    <>
      <line x1={PAD_L} y1={y} x2={W - 8} y2={y} stroke={AXIS_COLOR} strokeWidth={1} />
      {TICKS.map((t) => (
        <g key={t}>
          <line x1={lx(t)} y1={y} x2={lx(t)} y2={y + 4} stroke={AXIS_COLOR} strokeWidth={1} />
          <text x={lx(t)} y={y + 16} fontSize={10} fill={LABEL_COLOR} textAnchor="middle" fontFamily="ui-monospace, monospace">{t}</text>
        </g>
      ))}
      <text x={(PAD_L + W) / 2} y={y + 32} fontSize={11} fill={LABEL_COLOR} textAnchor="middle">latency (ms, log scale)</text>
    </>
  );
}

function YAxisTitle({ top, bot, label }: { top: number; bot: number; label: string }) {
  return (
    <text transform={`translate(13, ${(top + bot) / 2}) rotate(-90)`} fontSize={11} fill={LABEL_COLOR} textAnchor="middle">
      {label}
    </text>
  );
}

/** % of requests ≤ latency L for a provider's percentile array (0..100). */
function cdfAt(q: number[], L: number): number {
  if (L <= q[0]!) return 0;
  if (L >= q[100]!) return 100;
  let i = 0;
  while (i < 100 && q[i + 1]! <= L) i++;
  const span = q[i + 1]! - q[i]!;
  return span > 0 ? i + (L - q[i]!) / span : i;
}

// ---- 1. CDF --------------------------------------------------------------

export function CdfChart({ series }: ChartProps) {
  const H = 280;
  const top = 14;
  const bot = H - 40;
  const y = (pct: number) => bot - (pct / 100) * (bot - top);
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const onMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const { x, y: my } = svgCoords(ref.current, e.clientX, e.clientY, H);
    setHover({ x: Math.min(W - 8, Math.max(PAD_L, x)), y: my });
  };

  const lat = hover ? invLx(hover.x) : 0;
  const pts = hover ? series.map((s) => ({ s, pct: cdfAt(s.q, lat), py: y(cdfAt(s.q, lat)) })) : [];
  let nearestId: string | null = null;
  if (hover && pts.length) {
    let best = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.py - hover.y);
      if (d < best) {
        best = d;
        nearestId = p.s.id;
      }
    }
  }

  return (
    <svg ref={ref} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {[0, 25, 50, 75, 90, 95, 100].map((p) => (
        <g key={p}>
          <line x1={PAD_L} y1={y(p)} x2={W - 8} y2={y(p)} stroke={GRID_COLOR} strokeWidth={1} />
          <text x={PAD_L - 8} y={y(p) + 3} fontSize={10} fill={LABEL_COLOR} textAnchor="end" fontFamily="ui-monospace, monospace">{p}%</text>
        </g>
      ))}
      <YAxisTitle top={top} bot={bot} label="% of requests" />
      {series.map((s) => {
        const isNearest = nearestId === s.id;
        const isDimmed = nearestId !== null && !isNearest;
        const pls = s.q.map((l, i) => `${lx(l).toFixed(1)},${y(i).toFixed(1)}`).join(" ");
        return (
          <polyline
            key={s.id}
            points={pls}
            fill="none"
            stroke={s.color}
            strokeWidth={isNearest ? 3 : 2}
            opacity={isDimmed ? 0.18 : 0.92}
            style={{ transition: "opacity 80ms, stroke-width 80ms" }}
          />
        );
      })}
      {hover && (
        <g pointerEvents="none">
          <line x1={hover.x} x2={hover.x} y1={top} y2={bot} stroke="#444" strokeWidth={1} strokeDasharray="3 3" />
          {pts.map(({ s, py }) => {
            const isNearest = nearestId === s.id;
            return (
              <circle
                key={s.id}
                cx={hover.x}
                cy={py}
                r={isNearest ? 4.5 : 3.5}
                fill="#0f0f0f"
                stroke={s.color}
                strokeWidth={isNearest ? 2.5 : 2}
                opacity={nearestId !== null && !isNearest ? 0.3 : 1}
              />
            );
          })}
          <PositionedTip
            ax={hover.x}
            ay={hover.y}
            chartH={H}
            header={`${Math.round(lat)} ms`}
            rows={pts.map(({ s, pct }) => ({
              key: s.id,
              label: s.name,
              value: `${pct.toFixed(1)}%`,
              color: s.color,
              emphasized: nearestId === s.id,
              dimmed: nearestId !== null && nearestId !== s.id,
            }))}
          />
        </g>
      )}
      <XAxis y={bot} />
    </svg>
  );
}

// ---- 2. Density / histogram ----------------------------------------------

export function DensityChart({ series }: ChartProps) {
  const H = 280;
  const top = 14;
  const bot = H - 40;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  // Shared y-scale: share of a provider's own requests falling in a bucket,
  // normalized to the global max share so the y-axis can carry % ticks.
  const share = (s: DistributionSeries, cnt: number) => (s.n > 0 ? cnt / s.n : 0);
  let maxShare = 0;
  for (const s of series) for (const h of s.hist) maxShare = Math.max(maxShare, share(s, h.cnt));
  if (maxShare <= 0) maxShare = 1;
  const yOf = (sh: number) => bot - (sh / maxShare) * (bot - top);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxShare);

  const onMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const { x, y } = svgCoords(ref.current, e.clientX, e.clientY, H);
    setHover({ x: Math.min(W - 8, Math.max(PAD_L, x)), y });
  };

  let cursor: React.ReactNode = null;
  if (hover != null) {
    const b = bucketOf(invLx(hover.x));
    const cx = lx(binCenter(b));
    const rows: SvgTooltipRow[] = series.map((s) => {
      const cnt = s.hist.find((h) => h.bucket === b)?.cnt ?? 0;
      return { key: s.id, label: s.name, value: `${(100 * share(s, cnt)).toFixed(1)}%`, color: s.color };
    });
    cursor = (
      <g pointerEvents="none">
        <line x1={cx} x2={cx} y1={top} y2={bot} stroke="#444" strokeWidth={1} strokeDasharray="3 3" />
        <PositionedTip ax={cx} ay={hover.y} chartH={H} header={`~${Math.round(binCenter(b))} ms`} rows={rows} />
      </g>
    );
  }

  return (
    <svg ref={ref} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {yTicks.map((sh, i) => (
        <g key={i}>
          <line x1={PAD_L} y1={yOf(sh)} x2={W - 8} y2={yOf(sh)} stroke={GRID_COLOR} strokeWidth={1} />
          <text x={PAD_L - 8} y={yOf(sh) + 3} fontSize={10} fill={LABEL_COLOR} textAnchor="end" fontFamily="ui-monospace, monospace">
            {(sh * 100).toFixed(sh * 100 < 10 ? 1 : 0)}%
          </text>
        </g>
      ))}
      <YAxisTitle top={top} bot={bot} label="share of requests" />
      {series.map((s) => {
        const pts = [...s.hist]
          .filter((h) => h.bucket >= 1 && h.bucket <= NBINS)
          .sort((a, b) => a.bucket - b.bucket)
          .map((h) => `${lx(binCenter(h.bucket)).toFixed(1)},${yOf(share(s, h.cnt)).toFixed(1)}`);
        if (pts.length === 0) return null;
        return (
          <polyline
            key={s.id}
            points={`${PAD_L},${bot} ${pts.join(" ")} ${W - 8},${bot}`}
            fill={s.color}
            fillOpacity={0.1}
            stroke={s.color}
            strokeWidth={2}
            opacity={0.92}
          />
        );
      })}
      {cursor}
      <XAxis y={bot} />
    </svg>
  );
}

// ---- 3. Box / whisker ----------------------------------------------------

const BOX_ROW_H = 46;
const BOX_TOP = 30; // headroom above the first row
const BOX_LABEL_X = 3; // provider names left-aligned in the gutter (avoids clipping long names like "QuickNode" off the left edge)

interface BoxHover {
  pIdx: number;
  label: string;
  value: number;
  x: number;
  y: number;
}

export function BoxChart({ series }: ChartProps) {
  const H = series.length * BOX_ROW_H + 64;
  const bot = H - 40;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<BoxHover | null>(null);

  const rowCy = (i: number) => BOX_TOP + i * BOX_ROW_H;
  const markers = (s: DistributionSeries): [string, number][] => [
    ["min", s.min],
    ["p25", s.p25],
    ["p50 (median)", s.p50],
    ["p75", s.p75],
    ["p95", s.p95],
    ["p99", s.p99],
  ];

  // Anywhere in a provider's row: highlight that provider and snap the tooltip
  // to the nearest marker (min/p25/p50/p75/p95/p99) by x-distance.
  const onMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const { x, y } = svgCoords(ref.current, e.clientX, e.clientY, H);
    const i = Math.round((y - BOX_TOP) / BOX_ROW_H);
    if (i < 0 || i >= series.length || Math.abs(y - rowCy(i)) > BOX_ROW_H / 2) {
      setHover(null);
      return;
    }
    const s = series[i]!;
    let best = Infinity;
    let bl = "";
    let bv = 0;
    for (const [label, v] of markers(s)) {
      const d = Math.abs(lx(v) - x);
      if (d < best) {
        best = d;
        bl = label;
        bv = v;
      }
    }
    setHover({ pIdx: i, label: bl, value: bv, x: lx(bv), y: rowCy(i) });
  };

  return (
    <svg ref={ref} width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {TICKS.map((t) => (
        <line key={t} x1={lx(t)} y1={8} x2={lx(t)} y2={bot} stroke={GRID_COLOR} strokeWidth={1} />
      ))}
      {series.map((s, i) => {
        const cy = rowCy(i);
        const boxTop = cy - 11;
        const boxH = 22;
        const active = hover != null && hover.pIdx === i;
        const dim = hover != null && !active;
        return (
          <g key={s.id} opacity={dim ? 0.35 : 1} style={{ transition: "opacity 80ms" }}>
            {/* whisker min → p95 */}
            <line x1={lx(s.min)} y1={cy} x2={lx(s.p95)} y2={cy} stroke={s.color} strokeWidth={1.5} opacity={0.7} />
            <line x1={lx(s.min)} y1={cy - 5} x2={lx(s.min)} y2={cy + 5} stroke={s.color} strokeWidth={1.5} />
            <line x1={lx(s.p95)} y1={cy - 5} x2={lx(s.p95)} y2={cy + 5} stroke={s.color} strokeWidth={1.5} />
            {/* box p25–p75 */}
            <rect x={lx(s.p25)} y={boxTop} width={Math.max(1, lx(s.p75) - lx(s.p25))} height={boxH} fill={s.color} fillOpacity={0.22} stroke={s.color} strokeWidth={1.5} />
            {/* median */}
            <line x1={lx(s.p50)} y1={boxTop} x2={lx(s.p50)} y2={boxTop + boxH} stroke={s.color} strokeWidth={2.5} />
            {/* p99 dot */}
            <circle cx={lx(s.p99)} cy={cy} r={3} fill={s.color} />
            {/* highlighted marker (the one the tooltip is showing) */}
            {active && <circle cx={hover!.x} cy={cy} r={4.5} fill="#0f0f0f" stroke={s.color} strokeWidth={2.5} />}
            {/* provider name — in the left gutter, outside the plot */}
            <text x={BOX_LABEL_X} y={cy + 4} fontSize={9} fill="#e6e8ec" fontWeight={600}>{s.name}</text>
          </g>
        );
      })}
      {hover && series[hover.pIdx] && (
        <PositionedTip
          ax={hover.x}
          ay={hover.y}
          chartH={H}
          header={series[hover.pIdx]!.name}
          rows={[{ key: hover.label, label: hover.label, value: `${Math.round(hover.value)} ms` }]}
        />
      )}
      <XAxis y={bot} />
    </svg>
  );
}
