/**
 * Terminal rendering: a live table that redraws in place as samples land, plus
 * the final ranked report and a --json emitter.
 *
 * All progress/observer chatter goes to stderr (see index.ts / observe.ts) so
 * stdout carries only the table — keeping the in-place redraw uncorrupted and
 * `--json` output clean.
 */

import { DEFAULT_WEIGHTS, type ScoredProvider } from "@rpcbench/shared";
import type { ProviderAggregate } from "./aggregate.js";

export interface RunState {
  done: number;
  total: number;
  consensus: number;
  ambiguous: number;
  derivationFailed: number;
}

function fmtMs(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}ms`;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function tableLines(
  aggregates: readonly ProviderAggregate[],
  scored: readonly ScoredProvider[],
): string[] {
  const scoreById = new Map(scored.map((s) => [s.provider_id, s]));
  const sorted = [...aggregates].sort((a, b) => {
    const sa = scoreById.get(a.provider_id)?.total ?? -1;
    const sb = scoreById.get(b.provider_id)?.total ?? -1;
    return sb - sa;
  });

  const header =
    pad("Provider", 16) +
    " | " +
    rpad("p50 cold", 9) +
    " | " +
    rpad("p95 cold", 9) +
    " | " +
    rpad("p50 warm", 9) +
    " | " +
    rpad("p95 warm", 9) +
    " | " +
    rpad("n", 4) +
    " | " +
    rpad("correct%", 8) +
    " | " +
    rpad("score", 6);

  const lines = [header, "-".repeat(header.length)];
  for (const a of sorted) {
    const s = scoreById.get(a.provider_id);
    const correctCol = a.n_validated > 0 ? `${(a.correctness_rate * 100).toFixed(1)}%` : "n/a";
    const scoreCol = s ? s.total.toFixed(1) : "—";
    lines.push(
      pad(a.name, 16) +
        " | " +
        rpad(fmtMs(a.p50_cold), 9) +
        " | " +
        rpad(fmtMs(a.p95_cold), 9) +
        " | " +
        rpad(fmtMs(a.p50_warm), 9) +
        " | " +
        rpad(fmtMs(a.p95_warm), 9) +
        " | " +
        rpad(String(a.n_total), 4) +
        " | " +
        rpad(correctCol, 8) +
        " | " +
        rpad(scoreCol, 6),
    );
  }
  return lines;
}

function blockLines(
  aggregates: readonly ProviderAggregate[],
  scored: readonly ScoredProvider[],
  state: RunState,
): string[] {
  // NOTE: the (long, wrap-prone) correctness/mode label is intentionally NOT in
  // the live block — it's printed once to stderr at startup. The in-place redraw
  // relies on a stable logical→physical line count, which a wrapping line breaks.
  return [
    "Solana RPC Benchmark — live (measured from your machine)",
    `Challenges: ${state.done}/${state.total}  ` +
      `(${state.consensus} consensus · ${state.ambiguous} ambiguous · ${state.derivationFailed} derivation-failed)`,
    "",
    ...tableLines(aggregates, scored),
  ];
}

/** Redraws a fixed block of lines in place on each update (TTY only). */
export class LiveRenderer {
  private lastLineCount = 0;
  private readonly enabled = process.stdout.isTTY === true;

  update(
    aggregates: readonly ProviderAggregate[],
    scored: readonly ScoredProvider[],
    state: RunState,
  ): void {
    if (!this.enabled) return;
    // Clip every line to the terminal width so none wraps — a wrapped line would
    // occupy 2+ physical rows while counting as 1, throwing off the cursor-up
    // math below and causing the block to re-print instead of redraw in place.
    const cols = Math.max(20, (process.stdout.columns ?? 100) - 1);
    const clip = (s: string) => (s.length > cols ? s.slice(0, cols - 1) + "…" : s);
    const lines = blockLines(aggregates, scored, state).map(clip);
    if (this.lastLineCount > 0) {
      process.stdout.write(`\x1b[${this.lastLineCount}A`); // cursor up N lines
    }
    for (const l of lines) {
      process.stdout.write(`\x1b[2K${l}\n`); // clear line, then write
    }
    this.lastLineCount = lines.length;
  }
}

export function printFinalReport(opts: {
  aggregates: readonly ProviderAggregate[];
  scored: readonly ScoredProvider[];
  state: RunState;
  modeLabel: string;
  wallClockMs: number;
  startedAt: Date;
}): void {
  const sep = "=".repeat(80);
  const w = DEFAULT_WEIGHTS;
  const elapsedSec = opts.wallClockMs / 1000;
  const min = Math.floor(elapsedSec / 60);
  const s = Math.round(elapsedSec - min * 60);

  const out: string[] = [
    "",
    "Solana RPC Benchmark — one-shot run (measured from your machine)",
    sep,
    `Run started: ${opts.startedAt.toISOString()}`,
    `Challenges:  ${opts.state.done}  (${opts.state.consensus} consensus, ${opts.state.ambiguous} ambiguous, ${opts.state.derivationFailed} derivation-failed)`,
    opts.modeLabel,
    "",
    ...tableLines(opts.aggregates, opts.scored),
    "",
    `Score weights: ${w.latency} latency · ${w.winRate} win-rate · ${w.reliability} reliability · ${w.correctness} correctness · ${w.freshness} freshness`,
    `Wall-clock:    ${min}m ${s}s`,
    `Vantage:       local (single) — not the multi-region cloud comparison`,
    sep,
  ];
  console.log(out.join("\n"));
}

export function printJson(opts: {
  aggregates: readonly ProviderAggregate[];
  scored: readonly ScoredProvider[];
  state: RunState;
  mode: string;
  modeLabel: string;
  wallClockMs: number;
  startedAt: Date;
  methods: readonly string[];
}): void {
  const scoreById = new Map(opts.scored.map((s) => [s.provider_id, s]));
  console.log(
    JSON.stringify(
      {
        run_started_at: opts.startedAt.toISOString(),
        vantage: "local",
        correctness_mode: opts.mode,
        correctness_note: opts.modeLabel,
        methods: opts.methods,
        challenges_total: opts.state.done,
        challenges_consensus: opts.state.consensus,
        challenges_ambiguous: opts.state.ambiguous,
        challenges_derivation_failed: opts.state.derivationFailed,
        score_weights: DEFAULT_WEIGHTS,
        wall_clock_ms: opts.wallClockMs,
        providers: opts.aggregates.map((a) => ({
          ...a,
          score: scoreById.get(a.provider_id) ?? null,
        })),
      },
      null,
      2,
    ),
  );
}
