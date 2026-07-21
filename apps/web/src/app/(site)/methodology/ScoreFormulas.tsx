/**
 * Score-formula spec table for the methodology page — replaces the raw code
 * fence of the L/W/R/C/F formulas with a compact per-axis table (metric /
 * formula / meaning per row), led by a weight-split bar that makes the default
 * 50/45/5 mass distribution across Speed / Quality / Freshness visible at a
 * glance.
 *
 * Static (no interactivity): the methodology page documents the model; actual
 * weight tuning happens on the leaderboard via the preset chips / sliders on the
 * Overview. Figures are code-true to packages/shared/src/scoring.ts
 * (DEFAULT_WEIGHTS + computeScore).
 */

type Category = "speed" | "quality" | "freshness";

interface Axis {
  letter: string;
  name: string;
  weight: number;
  category: Category;
  formula: string;
  measure: string;
}

const AXES: readonly Axis[] = [
  {
    letter: "L",
    name: "Latency",
    weight: 0.25,
    category: "speed",
    formula: "100 × avg(fastest p50 / your p50, fastest p95 / your p95)",
    measure:
      "Blends “usually fast” (p50 median) with “tight tail” (p95), each scored against the panel’s best.",
  },
  {
    letter: "W",
    name: "Win rate",
    weight: 0.25,
    category: "speed",
    formula: "100 × your win rate / best win rate",
    measure:
      "Share of challenges where this provider was the single fastest correct sample, normalized to the panel’s best winner.",
  },
  {
    letter: "R",
    name: "Reliability",
    weight: 0.25,
    category: "quality",
    formula: "100 × responses that succeeded / non-ambiguous samples",
    measure:
      "Share of non-ambiguous samples that responded. An HTTP 200 with incorrect data still counts as reliable, but not correct.",
  },
  {
    letter: "C",
    name: "Correctness",
    weight: 0.2,
    category: "quality",
    formula: "100 × correct / (correct + incorrect + stale)",
    measure:
      "Share of validated samples that were correct. Timeouts hit R, not C, so a sample is never penalized twice.",
  },
  {
    letter: "F",
    name: "Freshness",
    weight: 0.05,
    category: "freshness",
    formula: "100 × lowest tip-lag / your tip-lag",
    measure: "Tip-lag at p95 versus the panel’s freshest. A tiebreaker, not a primary axis.",
  },
];

const CATEGORIES: ReadonlyArray<{ key: Category; label: string }> = [
  { key: "speed", label: "Speed" },
  { key: "quality", label: "Quality" },
  { key: "freshness", label: "Freshness" },
];

// Literal class strings (Tailwind JIT can't see interpolated ones).
const CAT_STYLE: Record<Category, { dot: string; badge: string; bar: string }> = {
  speed: {
    dot: "bg-[#6fb3ff]",
    badge: "bg-[color-mix(in_oklch,#6fb3ff_16%,transparent)] text-[#6fb3ff]",
    bar: "bg-[#6fb3ff]",
  },
  quality: {
    dot: "bg-[#7be0a4]",
    badge: "bg-[color-mix(in_oklch,#7be0a4_16%,transparent)] text-[#7be0a4]",
    bar: "bg-[#7be0a4]",
  },
  freshness: {
    dot: "bg-[#f0a868]",
    badge: "bg-[color-mix(in_oklch,#f0a868_16%,transparent)] text-[#f0a868]",
    bar: "bg-[#f0a868]",
  },
};

function catWeight(c: Category): number {
  return AXES.filter((a) => a.category === c).reduce((s, a) => s + a.weight, 0);
}

export default function ScoreFormulas() {
  return (
    <div className="my-6">
      {/* Weight-split bar: visualizes the default 50 / 45 / 5 mass. */}
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        {CATEGORIES.map((c) => (
          <div
            key={c.key}
            className={CAT_STYLE[c.key].bar}
            style={{ width: `${catWeight(c.key) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
        {CATEGORIES.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-2 font-geistmono text-[11px] text-fg2">
            <span className={"h-2 w-2 rounded-full " + CAT_STYLE[c.key].dot} />
            {c.label}
            <span className="text-muted">{Math.round(catWeight(c.key) * 100)}%</span>
          </span>
        ))}
      </div>

      {/* Per-axis spec table — metric, formula, and meaning on one dense row
          each (stacks on narrow screens). Far tighter than padded cards. */}
      <div className="mt-4 border-t border-line">
        <div className="hidden min-[640px]:grid grid-cols-[150px_minmax(0,1fr)_minmax(0,1.15fr)] gap-x-5 py-2 border-b border-line font-geistmono text-[10px] uppercase tracking-[0.12em] text-muted">
          <span>Metric</span>
          <span>Formula</span>
          <span>What it measures</span>
        </div>
        {AXES.map((a) => (
          <div
            key={a.letter}
            className="grid grid-cols-1 min-[640px]:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.15fr)] gap-x-5 gap-y-1.5 py-3 border-b border-line/60 min-[640px]:items-start"
          >
            <div className="flex items-center gap-2">
              <span
                className={
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-geistmono text-[12px] font-semibold " +
                  CAT_STYLE[a.category].badge
                }
              >
                {a.letter}
              </span>
              <span className="text-[13px] font-medium text-fg">{a.name}</span>
              <span className="ml-auto min-[640px]:ml-0 font-geistmono text-[10.5px] text-muted">
                w {a.weight.toFixed(2)}
              </span>
            </div>
            <code className="min-w-0 whitespace-pre-wrap break-words font-geistmono text-[11.5px] leading-[1.45] text-[#e0a878]">
              {a.formula}
            </code>
            <p className="min-w-0 mb-0 text-[12px] leading-[1.5] text-fg2">{a.measure}</p>
          </div>
        ))}
      </div>

      {/* Combined total. */}
      <div className="mt-3 rounded-lg border border-line2 bg-surface2 px-4 py-3 font-geistmono text-[12.5px] leading-[1.6] text-fg2">
        <span className="text-muted">total = </span>
        <span className="text-fg">
          w<sub>L</sub>·L + w<sub>W</sub>·W + w<sub>R</sub>·R + w<sub>C</sub>·C + w<sub>F</sub>·F
        </span>
        <span className="text-muted"> · clamped 0–100, blended across geos by region weight</span>
      </div>
    </div>
  );
}
