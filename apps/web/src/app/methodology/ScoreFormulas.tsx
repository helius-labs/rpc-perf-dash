/**
 * Score-formula card grid for the methodology page — replaces the raw code
 * fence of the L/W/R/C/F formulas with a per-axis card layout grouped by
 * category (Speed / Quality / Freshness), led by a weight-split bar that makes
 * the default 50/45/5 mass distribution visible at a glance.
 *
 * Static (no interactivity): the methodology page documents the model; actual
 * weight tuning happens on the leaderboard via URL params. Figures are
 * code-true to packages/shared/src/scoring.ts (DEFAULT_WEIGHTS + computeScore).
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
    formula: "0.5·clamp(best_p50 / p50) + 0.5·clamp(best_p95 / p95)",
    measure:
      "Blends “usually fast” (p50 median) with “tight tail” (p95), each scored against the panel’s best.",
  },
  {
    letter: "W",
    name: "Win rate",
    weight: 0.25,
    category: "speed",
    formula: "clamp(win_rate / best_win_rate) · 100",
    measure:
      "Share of challenges where this provider was the single fastest correct sample, normalized to the panel’s best winner.",
  },
  {
    letter: "R",
    name: "Reliability",
    weight: 0.25,
    category: "quality",
    formula: "success_rate · 100   ·   ok ∧ ¬ambiguous / ¬ambiguous",
    measure:
      "Share of non-ambiguous samples that responded. An HTTP 200 with incorrect data still counts as reliable, but not correct.",
  },
  {
    letter: "C",
    name: "Correctness",
    weight: 0.2,
    category: "quality",
    formula: "correct / validated · 100   ·   validated = correct + incorrect + stale",
    measure:
      "Share of validated samples that were correct. Timeouts hit R, not C, so a sample is never penalized twice.",
  },
  {
    letter: "F",
    name: "Freshness",
    weight: 0.05,
    category: "freshness",
    formula: "clamp(best_p95_lag / p95_lag) · 100",
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

      {/* Per-axis cards. */}
      <div className="mt-4 grid grid-cols-1 gap-3 min-[560px]:grid-cols-2 min-[920px]:grid-cols-3">
        {AXES.map((a) => (
          <div key={a.letter} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-2.5">
              <span
                className={
                  "inline-flex h-6 w-6 items-center justify-center rounded-md font-geistmono text-[13px] font-semibold " +
                  CAT_STYLE[a.category].badge
                }
              >
                {a.letter}
              </span>
              <span className="text-[14px] font-medium text-fg">{a.name}</span>
              <span className="ml-auto font-geistmono text-[11px] text-muted">w {a.weight.toFixed(2)}</span>
            </div>
            <code className="mt-3 block whitespace-pre-wrap break-words rounded bg-bg px-2.5 py-2 font-geistmono text-[11.5px] leading-[1.5] text-[#e0a878]">
              {a.formula}
            </code>
            <p className="mt-2.5 mb-0 text-[12.5px] leading-[1.5] text-fg2">{a.measure}</p>
          </div>
        ))}
      </div>

      {/* Combined total. */}
      <div className="mt-3 rounded-lg border border-line2 bg-surface2 px-4 py-3 font-geistmono text-[12.5px] leading-[1.6] text-fg2">
        <span className="text-muted">total = </span>
        <span className="text-fg">
          w<sub>L</sub>·L + w<sub>W</sub>·W + w<sub>R</sub>·R + w<sub>C</sub>·C + w<sub>F</sub>·F
        </span>
        <span className="text-muted"> · clamped 0–100, blended across geos by region weight · tunable via URL params</span>
      </div>
    </div>
  );
}
