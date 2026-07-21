import { HANDLERS } from "@rpcbench/methods";
import type { CanonicalProjection, Correctness, Method } from "@rpcbench/shared";

// ────────────────────────────────────────────────────────────────────────
// Failure categorization (separate from classify; called by record.ts).
// ────────────────────────────────────────────────────────────────────────

export interface CategorizeFailureInput {
  status: "ok" | "error" | "timeout";
  http_status: number | null;
  error_code: string | null;
  body: string | null;
  correctness: Correctness;
  exclusion_reason: string | null;
  freshness_lag: bigint;
  /** Client timeout budget that applied to this call (bucket-aware: 5s
   * default, 10s for archival/honeypot buckets). Used only for the
   * failure_detail label. */
  timeout_ms?: number;
}

export interface CategorizeFailureOutput {
  failure_category: string | null;
  failure_detail: string | null;
}

const QUOTA_RE = /monthly capacity|credit.*exceeded|out of credits|insufficient.*credit/i;
const METHOD_BLOCK_RE = /method.*not available.*upgrade|paid tier required/i;
const RATE_LIMIT_RE = /rate.?limit|too many requests|throttled/i;

/**
 * Operator-side operational error (billing quota / rate-limit) returned as an
 * HTTP-200 JSON-RPC error body. It's the benchmark account's own credit cap, not a
 * provider data or availability defect, so decideProviderOutcome routes it to a
 * no-fault `operational_error` exclusion (out of both correctness and reliability).
 * method_blocked is intentionally NOT included — a method-not-available error on a
 * method we didn't declare unsupported is a config issue, not a billing cap.
 */
export function isOperationalError(body: string | null): boolean {
  if (!body) return false;
  return QUOTA_RE.test(body) || RATE_LIMIT_RE.test(body);
}

/**
 * Bucketize a non-correct sample into a finer-grained failure category.
 * First match wins. `correct` samples short-circuit to NULL/NULL.
 */
export function categorizeFailure(input: CategorizeFailureInput): CategorizeFailureOutput {
  // Rule 1 — short-circuit for correct samples.
  if (input.correctness === "correct") {
    return { failure_category: null, failure_detail: null };
  }

  // Rule 1b — freshness_ahead is a no-fault exclusion (provider read a strictly
  // fresher slot than the panel), not a failure — keep it out of every failure
  // surface (leaderboard_failures via scf already drops ambiguous; this also keeps
  // it out of health.ts top_failure). operational_error deliberately falls through
  // so it still gets a quota_exhausted/rate_limited label for /raw (it's excluded
  // from leaderboard_failures anyway because its correctness is 'ambiguous').
  if (input.exclusion_reason === "freshness_ahead") {
    return { failure_category: null, failure_detail: null };
  }

  // Rule 2 — network timeout.
  if (input.status === "timeout") {
    const seconds = Math.round((input.timeout_ms ?? 5000) / 1000);
    return { failure_category: "network_timeout", failure_detail: `client_timeout_${seconds}s` };
  }

  // Rule 3 — network error (genuinely NO HTTP response: DNS/TLS/connect
  // failure). An HTTP error *response* also carries status="error" (see
  // fanout.ts fromHttpResponse — a 4xx/5xx is a reliability failure, not a
  // correctness vote), but it has an http_status set, so let it fall through to
  // the HTTP-status rules below (429 → rate_limited, 402 → method_blocked, …)
  // instead of collapsing every rate-limit into a generic network_error.
  if (input.status === "error" && input.http_status == null) {
    return { failure_category: "network_error", failure_detail: input.error_code ?? null };
  }

  // Rules 4-9 require body inspection. Try to parse once.
  const body = input.body;
  type ParsedBody = { result?: unknown; error?: { code?: number; message?: string } };
  let parsed: ParsedBody | null = null;
  let parseFailed = false;
  if (body) {
    try {
      parsed = JSON.parse(body) as ParsedBody;
    } catch {
      parseFailed = true;
    }
  }

  // Tier-method-unsupported is a known disclosed limitation, not a real
  // failure — distinguish it from other JSON-RPC errors so dashboards don't
  // surface e.g. QuickNode's missing simulateBundle as a generic "rpc_error".
  if (input.exclusion_reason === "tier_method_unsupported") {
    return { failure_category: "tier_unsupported", failure_detail: null };
  }

  // Rule 4 — body-content regexes (specific wins before HTTP-status).
  if (body) {
    if (QUOTA_RE.test(body)) {
      return {
        failure_category: "quota_exhausted",
        failure_detail: detectVendorQuota(body),
      };
    }
    if (METHOD_BLOCK_RE.test(body)) {
      return {
        failure_category: "method_blocked",
        failure_detail: "method_not_available",
      };
    }
    if (RATE_LIMIT_RE.test(body)) {
      return { failure_category: "rate_limited", failure_detail: "body_rate_limit" };
    }
  }

  // Rule 5 — HTTP 429.
  if (input.http_status === 429) {
    return { failure_category: "rate_limited", failure_detail: "http_429" };
  }

  // Rule 6 — HTTP 402.
  if (input.http_status === 402) {
    return { failure_category: "method_blocked", failure_detail: "http_402" };
  }

  // Rule 7 — generic HTTP error.
  if (input.http_status != null && input.http_status >= 400 && input.http_status < 600) {
    return { failure_category: "http_error", failure_detail: `http_${input.http_status}` };
  }

  // Rule 8 — body unparseable.
  if (parseFailed) {
    return { failure_category: "body_invalid", failure_detail: "unparseable" };
  }

  // Rule 9 — JSON-RPC error in body.
  if (parsed?.error) {
    const code = parsed.error.code ?? "unknown";
    return { failure_category: "rpc_error", failure_detail: `jsonrpc_error_${code}` };
  }

  // Rule 10 — incomplete (provider returned null where reference had data).
  if (input.correctness === "incomplete") {
    const detail =
      parsed && parsed.result === null ? "null_response" : "incomplete";
    return { failure_category: "incomplete", failure_detail: detail };
  }

  // Rule 11 — stale (slot lag).
  if (input.correctness === "stale") {
    return {
      failure_category: "stale",
      failure_detail: `lag_${input.freshness_lag.toString()}_slots`,
    };
  }

  // Rule 12 — ambiguous (no panel consensus).
  if (input.correctness === "ambiguous") {
    const detail = input.exclusion_reason === "no_consensus" ? "no_consensus" : null;
    return { failure_category: "no_consensus", failure_detail: detail };
  }

  // Rule 13 — fallback: hash mismatch with no other detected cause.
  return { failure_category: "data_mismatch", failure_detail: null };
}

/** Recognize common vendor-specific quota error strings. */
function detectVendorQuota(body: string): string {
  if (/Alchemy/i.test(body) && /Monthly capacity/i.test(body)) {
    return "alchemy_monthly_capacity_exceeded";
  }
  if (/credit/i.test(body)) return "credits_exhausted";
  return "quota_exhausted";
}

// ────────────────────────────────────────────────────────────────────────
// Per-response projection. The consensus orchestrator in record.ts uses this
// to build voters and then re-uses classifyAgainstReference() to score each
// provider.
// ────────────────────────────────────────────────────────────────────────

export interface ProjectAttempt {
  /** Present iff status=ok AND body parsed AND no JSON-RPC error. */
  projection: CanonicalProjection | null;
  /** Raw parsed JSON-RPC result, when projection succeeded. */
  result: unknown;
  /** Hex-or-empty hash for the sample row regardless of whether projection succeeded. */
  response_hash: Buffer;
  response_slot: bigint | null;
  /**
   * One of:
   *   "ok"                  — projection succeeded; voter is eligible.
   *   "reliability_failure" — transport-level (timeout/error or no body).
   *   "body_invalid"        — HTTP 200 but body unparseable.
   *   "rpc_error"           — body had a JSON-RPC `error` field.
   */
  outcome: "ok" | "reliability_failure" | "body_invalid" | "rpc_error";
}

/** Attempt to project a single provider response. Pure — no DB / network. */
export function projectResponse(
  method: Method,
  body: string | null,
  status: "ok" | "error" | "timeout",
): ProjectAttempt {
  if (status !== "ok" || !body) {
    return {
      projection: null,
      result: null,
      response_hash: Buffer.alloc(0),
      response_slot: null,
      outcome: "reliability_failure",
    };
  }

  let parsed: { result?: unknown; error?: { message: string } };
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      projection: null,
      result: null,
      response_hash: Buffer.alloc(0),
      response_slot: null,
      outcome: "body_invalid",
    };
  }

  if (parsed.error !== undefined) {
    return {
      projection: null,
      result: null,
      response_hash: Buffer.alloc(0),
      response_slot: null,
      outcome: "rpc_error",
    };
  }

  const handler = HANDLERS[method];
  const projection = handler.project(parsed.result);
  let response_slot: bigint | null = null;
  // Most methods carry the slot at `result.slot`; context-wrapped methods
  // (getBalance/getSupply/getTokenSupply/getTokenLargestAccounts/
  // getLatestBlockhash/getTokenAccountBalance, plus getAccountInfo etc.) carry
  // it at `result.context.slot`. Diagnostic column only — freshness/stale logic
  // uses the fanout tip piggyback, not this value.
  const r = parsed.result as { slot?: number; context?: { slot?: number } } | null;
  if (r && typeof r.slot === "number") response_slot = BigInt(r.slot);
  else if (r && typeof r.context?.slot === "number") response_slot = BigInt(r.context.slot);

  return {
    projection,
    result: parsed.result,
    response_hash: Buffer.from(projection.hash),
    response_slot,
    outcome: "ok",
  };
}

export interface ClassifyAgainstReferenceInput {
  method: Method;
  /** Challenge bucket — handlers with bucket-dependent match strictness
   * (sigs archival) read it; all others ignore it. */
  bucket: string;
  projection: CanonicalProjection;
  reference: { hash: Uint8Array; shape: unknown };
  reference_tip_slot: bigint;
  provider_tip_slot: bigint;
}

/**
 * Classify a single provider's projection against an established reference
 * (consensus reference, or pre-seeded honeypot answer). Returns one of
 * `correct | incorrect | stale | incomplete` per the per-method handler's
 * rules (e.g. mutable-state methods downgrade hash-mismatch + newer-tip to
 * `stale` rather than `incorrect`).
 */
export function classifyAgainstReference(
  input: ClassifyAgainstReferenceInput,
): Correctness {
  return HANDLERS[input.method].classify(
    input.projection,
    input.reference,
    input.provider_tip_slot,
    input.reference_tip_slot,
    input.bucket,
  );
}
