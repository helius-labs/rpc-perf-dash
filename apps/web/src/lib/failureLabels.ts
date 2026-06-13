/**
 * Human-readable labels + one-line explanations for the failure categories the
 * runner emits (packages/runner/src/classify.ts:categorizeFailure). These are
 * the codes stored in samples.failure_category / failure_detail and summed into
 * the leaderboard_failures_{1h,1d} precompute — raw codes like `http_402` or
 * `alchemy_monthly_capacity_exceeded` aren't user-facing on their own.
 *
 * `no_consensus` / `consensus_disputed` are intentionally omitted: ambiguous
 * samples are excluded from the "calls failed" count (success_rate_calls
 * denominator) so they never appear in a failure breakdown — see the rollup
 * scf predicate.
 */

export interface FailureDescription {
  /** Short, title-case label for the breakdown row. */
  label: string;
  /** One-line plain-English explanation (tooltip / title text). */
  hint: string;
}

/** Friendly label + hint per failure_category. */
export const FAILURE_LABELS: Record<string, FailureDescription> = {
  network_timeout: {
    label: "Timed out",
    hint: "No response within the client budget (5s default; 10s for archival/honeypot buckets).",
  },
  network_error: {
    label: "Network error",
    hint: "Connection failed before any HTTP response (DNS, refused, reset).",
  },
  quota_exhausted: {
    label: "Quota exhausted",
    hint: "Monthly capacity or credits used up on the provider's plan.",
  },
  method_blocked: {
    label: "Method blocked",
    hint: "RPC method not available on this provider's plan tier.",
  },
  rate_limited: {
    label: "Rate limited",
    hint: "Provider throttled the request (HTTP 429 / rate-limit body).",
  },
  http_error: {
    label: "HTTP error",
    hint: "Provider returned a 4xx/5xx HTTP status.",
  },
  body_invalid: {
    label: "Invalid response",
    hint: "Response body could not be parsed as JSON.",
  },
  rpc_error: {
    label: "RPC error",
    hint: "Provider returned a JSON-RPC error object.",
  },
  incomplete: {
    label: "Incomplete data",
    hint: "Provider returned null/partial data where the reference had a result.",
  },
  stale: {
    label: "Stale",
    hint: "Provider's response lagged the reference tip by too many slots.",
  },
  data_mismatch: {
    label: "Wrong data",
    hint: "Response didn't match the quorum reference, with no other detected cause.",
  },
};

const UNKNOWN: FailureDescription = {
  label: "Other failure",
  hint: "Uncategorized failure.",
};

/**
 * Describe a (category, detail) pair. Falls back to the category label, then to
 * a generic "Other failure". `detail` refines the label/hint for the cases worth
 * distinguishing (specific HTTP codes, vendor quota strings, slot lag, RPC code).
 */
export function describeFailure(
  category: string,
  detail: string | null,
): FailureDescription {
  const base = FAILURE_LABELS[category] ?? UNKNOWN;
  if (!detail) return base;

  switch (detail) {
    case "http_429":
      return { label: "Rate limited", hint: "Provider returned HTTP 429 (too many requests)." };
    case "body_rate_limit":
      return { label: "Rate limited", hint: "Provider's response body indicated rate limiting." };
    case "http_402":
      return { label: "Payment required", hint: "Provider returned HTTP 402; the method needs a paid tier." };
    case "method_not_available":
      return { label: "Method blocked", hint: "Provider reported the method is unavailable on this plan." };
    case "alchemy_monthly_capacity_exceeded":
      return { label: "Quota exhausted", hint: "Alchemy monthly capacity exceeded." };
    case "credits_exhausted":
      return { label: "Quota exhausted", hint: "Provider credits exhausted." };
    case "null_response":
      return { label: "Incomplete data", hint: "Provider returned null where the reference had a result." };
    case "unparseable":
      return { label: "Invalid response", hint: "Response body was not valid JSON." };
    default:
      break;
  }

  // Dynamic details.
  const timeoutMatch = /^client_timeout_(\d+)s$/.exec(detail);
  if (timeoutMatch) {
    return { label: "Timed out", hint: `No response within the ${timeoutMatch[1]}s client budget.` };
  }
  const httpMatch = /^http_(\d{3})$/.exec(detail);
  if (httpMatch) {
    return { label: `HTTP ${httpMatch[1]}`, hint: `Provider returned HTTP status ${httpMatch[1]}.` };
  }
  const rpcMatch = /^jsonrpc_error_(.+)$/.exec(detail);
  if (rpcMatch) {
    return { label: `RPC error ${rpcMatch[1]}`, hint: `JSON-RPC error code ${rpcMatch[1]}.` };
  }
  const lagMatch = /^lag_(\d+)_slots$/.exec(detail);
  if (lagMatch) {
    return { label: "Stale", hint: `Response lagged the reference tip by ${lagMatch[1]} slots.` };
  }

  // Unknown detail under a known category: keep the category label, append detail to hint.
  return { label: base.label, hint: `${base.hint} (${detail})` };
}
