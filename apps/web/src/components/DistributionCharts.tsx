/**
 * Latency-distribution chart primitives — three pure-SVG views of a per-provider
 * latency distribution, rendered from the same `DistributionSeries` data:
 *
 *   1. CdfChart      — cumulative (% of requests ≤ x ms), the fast left edge is
 *                      what wins races.
 *   2. DensityChart  — log-x histogram ("bell curve done right"): real shape,
 *                      hard floor, long right tail.
 *   3. BoxChart      — compact p25/p50/p75 box, whisker→p95, p99 dot, min tick.
 *
 * No hooks — safe to import into client or server components. Data comes from
 * `fetchLatencyDistribution` (apps/web/src/lib/distribution.ts). Originally
 * prototyped on the temporary /distribution page (commit 60b15bb); lifted here
 * with the layout constants/scale at module scope so the charts are
 * self-contained (callers pass only `series`).
 */

// ---- shared log-x scale + layout (module scope) --------------------------

const W = 860;
const PAD_L = 56;
const PAD_R = 16;
const INNER_W = W - PAD_L - PAD_R;
const XMIN = 3;
const XMAX = 2000;
const TICKS = [3, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];

/** Map a latency in ms to an x pixel on the fixed log scale [3, 2000]. */
function lx(v: number): number {
  const c = Math.min(XMAX, Math.max(XMIN, v));
  return PAD_L + ((Math.log(c) - Math.log(XMIN)) / (Math.log(XMAX) - Math.log(XMIN))) * INNER_W;
}

// Log-spaced histogram domain (ms): 60 bins between e^L0 and e^L1.
const L0 = Math.log(2);
const L1 = Math.log(2000);
const NBINS = 60;
const BIN_STEP = (L1 - L0) / NBINS;
/** Center latency (ms) of histogram bucket b (1..NBINS). */
export function binCenter(b: number): number {
  return Math.exp(L0 + (b - 0.5) * BIN_STEP);
}
export { L0 as HIST_L0, L1 as HIST_L1, NBINS as HIST_NBINS };

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

// ---- charts --------------------------------------------------------------

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

export function CdfChart({ series }: ChartProps) {
  const H = 280;
  const top = 14;
  const bot = H - 40;
  const y = (pct: number) => bot - (pct / 100) * (bot - top);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {[0, 25, 50, 75, 90, 95, 100].map((p) => (
        <g key={p}>
          <line x1={PAD_L} y1={y(p)} x2={W - 8} y2={y(p)} stroke={GRID_COLOR} strokeWidth={1} />
          <text x={PAD_L - 8} y={y(p) + 3} fontSize={10} fill={LABEL_COLOR} textAnchor="end" fontFamily="ui-monospace, monospace">{p}%</text>
        </g>
      ))}
      {series.map((s) => {
        const pts = s.q.map((lat, i) => `${lx(lat).toFixed(1)},${y(i).toFixed(1)}`).join(" ");
        return <polyline key={s.id} points={pts} fill="none" stroke={s.color} strokeWidth={2} opacity={0.92} />;
      })}
      <XAxis y={bot} />
    </svg>
  );
}

export function DensityChart({ series }: ChartProps) {
  const H = 280;
  const top = 14;
  const bot = H - 40;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      <line x1={PAD_L} y1={top} x2={PAD_L} y2={bot} stroke={GRID_COLOR} strokeWidth={1} />
      {series.map((s) => {
        const pts = [...s.hist]
          .filter((h) => h.bucket >= 1 && h.bucket <= NBINS)
          .sort((a, b) => a.bucket - b.bucket)
          .map((h) => {
            const x = lx(binCenter(h.bucket));
            const yy = bot - (h.cnt / s.histMax) * (bot - top);
            return `${x.toFixed(1)},${yy.toFixed(1)}`;
          });
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
      <XAxis y={bot} />
    </svg>
  );
}

export function BoxChart({ series }: ChartProps) {
  const rowH = 46;
  const H = series.length * rowH + 52;
  const bot = H - 40;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {TICKS.map((t) => (
        <line key={t} x1={lx(t)} y1={8} x2={lx(t)} y2={bot} stroke={GRID_COLOR} strokeWidth={1} />
      ))}
      {series.map((s, i) => {
        const cy = 20 + i * rowH;
        const boxTop = cy - 11;
        const boxH = 22;
        return (
          <g key={s.id}>
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
            {/* label */}
            <text x={PAD_L} y={cy - 15} fontSize={11} fill="#e6e8ec" fontWeight={600}>{s.name}</text>
            <text x={W - 8} y={cy - 15} fontSize={11} fill={LABEL_COLOR} textAnchor="end" fontFamily="ui-monospace, monospace">win {s.winPct.toFixed(1)}%</text>
          </g>
        );
      })}
      <XAxis y={bot} />
    </svg>
  );
}
