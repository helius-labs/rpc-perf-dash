/**
 * Correctness-regime determination + the method-aware mode label.
 *
 * Two correctness paths, both via `buildSampleRows`:
 *
 *  - **vs-reference** (`--reference`/`--auditor` set): each challenge is built
 *    with `is_honeypot: true` and the reference projection as the known answer.
 *    `buildSampleRows` scores every provider directly against it. This is the
 *    only way to get correctness with 1–2 endpoints — for a normal
 *    (non-honeypot) challenge, `buildSampleRows` ignores the passed reference
 *    and derives correctness purely from panel consensus (record.ts's
 *    `buildRowsForMode`, gated on `!input.is_honeypot`).
 *
 *  - **consensus** (default, ≥3 endpoints): normal challenges, correctness by
 *    majority vote among the user's endpoints. The floors are method-derived
 *    from the global benchmarked roster via the shared
 *    `consensusFloorsForMethod()` (also used by record.ts's `decideForMode`):
 *    minGroup 3 for most methods, 2 for methods whose full roster panel is
 *    structurally ≤3 voters (roster providers declare them unsupported). So at
 *    exactly 3 endpoints, minGroup=3 methods need unanimity (a 2-1 dissent is
 *    dropped as no_consensus, not attributed) while minGroup=2 methods
 *    attribute the dissenter. Uniform dissent detection arrives at ≥5
 *    endpoints.
 *
 * With <3 endpoints and no reference, correctness simply can't form → n/a; only
 * latency / reliability / freshness are reported.
 */

import { MIN_CONSENSUS_VOTERS, consensusFloorsForMethod, type Method } from "@rpcbench/shared";
import type { CliConfig } from "./config.js";

/**
 * The `minGroup` `buildSampleRows` (record.ts's `decideForMode`) will derive
 * for a method, read off the same shared `consensusFloorsForMethod()`: a
 * structural panel of ≤3 providers relaxes minGroup to 2.
 */
export function minGroupForMethod(method: Method): number {
  return consensusFloorsForMethod(method).minGroup;
}

export type CorrectnessMode = "vs-reference" | "consensus" | "n/a";

export interface Regime {
  mode: CorrectnessMode;
  /** True → build challenges as honeypots scored against the fetched reference. */
  useReference: boolean;
  /** One-line label for the report header. */
  label: string;
}

export function determineRegime(config: CliConfig, referenceLabel: string): Regime {
  const n = config.providers.length;

  if (config.hasExplicitReference) {
    return {
      mode: "vs-reference",
      useReference: true,
      label: `correctness: vs reference (${referenceLabel}) — each endpoint scored against your trusted node`,
    };
  }

  if (n < MIN_CONSENSUS_VOTERS) {
    return {
      mode: "n/a",
      useReference: false,
      label: `correctness: n/a — need ≥${MIN_CONSENSUS_VOTERS} endpoints for consensus, or pass --reference <url>; showing latency/reliability only`,
    };
  }

  // Consensus mode. Describe the method-aware minGroup regime.
  const minGroups = new Set(config.methods.map(minGroupForMethod));
  let detail: string;
  if (config.methods.length === 1) {
    const mg = minGroupForMethod(config.methods[0]!);
    detail =
      mg === 2
        ? `minGroup=2 — a 2-1 dissent forms consensus and is attributed`
        : `minGroup=3 — needs a ≥3 agreement group`;
  } else if (minGroups.size === 1) {
    detail = `minGroup=${[...minGroups][0]} across selected methods`;
  } else {
    detail =
      `minGroup 2–3, varies by method: the reduced-panel methods ` +
      `(simulateBundle, getTransactionsForAddress) use 2, the rest 3`;
  }

  let caveat = "";
  if (n === 3 && minGroups.has(3)) {
    caveat =
      ` — at 3 endpoints, minGroup=3 methods require unanimity (a 2-1 dissent is` +
      ` dropped as no_consensus, not attributed); use ≥5 endpoints for uniform` +
      ` dissent detection`;
  } else if (n === 4) {
    caveat = ` — 2-2 splits stay ambiguous; use ≥5 endpoints for robust dissent detection`;
  }

  return {
    mode: "consensus",
    useReference: false,
    label: `correctness: consensus (${n} endpoints, ${detail})${caveat}`,
  };
}
