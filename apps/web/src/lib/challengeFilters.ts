/**
 * Client-safe half of the /challenges data model: filter types, status
 * vocabulary, and query-param parsing. Shared by the server page, the
 * /api/challenges route, and the polling ChallengesTable client component.
 * The SQL fetchers live in lib/challengeRows.ts (server-only — it imports
 * the DB client).
 */

import { type Method } from "@rpcbench/shared";
import { ALL_METHODS } from "@/lib/methods";
import { WINDOW_VALUES } from "@/lib/windows";

/**
 * Challenge status filter. The DB stores the raw enum (`ready` and `expired`
 * for current traffic). The UI relabels `ready` → "dispatched" to match the
 * home-page tooltip — that's the actual dispatch-lifecycle meaning.
 *
 * Legacy DB rows (a few thousand) have
 * `ambiguous` / `pending_quorum` statuses; they'll show up under "All" with
 * their raw status text but aren't exposed as filter options since no new
 * challenges land in those states.
 */
export const STATUS_OPTIONS = [
  { value: "ready", label: "dispatched" },
  { value: "expired", label: "expired" },
] as const;
export type StatusFilter = (typeof STATUS_OPTIONS)[number]["value"];
export const ALL_STATUSES = STATUS_OPTIONS.map((s) => s.value) as readonly StatusFilter[];

export const PAGE_SIZE = 50;
export const MAX_TARGET_LEN = 128;

export interface ChallengeRow {
  id: string;
  method: string;
  bucket: string;
  status: string;
  generated_at: string | Date;
  params: unknown;
  is_honeypot: boolean;
  total: number;
  correct: number;
  ambiguous: number;
  incorrect: number;
  disputed: number;
}

/** Validated, serializable filter set — the cache key for one challenges view. */
export interface ChallengesFilters {
  method: Method | null;
  bucket: string | null;
  status: string | null;
  window: number;
  target: string;
  offset: number;
}

/** Filter set without `offset` — the cache key for offset-independent queries. */
export type ChallengesFiltersNoOffset = Omit<ChallengesFilters, "offset">;

/**
 * Validate raw query/search params into a ChallengesFilters. Used by both the
 * /challenges page and the /api/challenges route so SSR and the client poll
 * parse identically.
 */
export function parseChallengesFilters(
  params: Partial<
    Record<"method" | "bucket" | "status" | "window" | "target" | "offset", string | undefined>
  >,
): ChallengesFilters {
  const method = (ALL_METHODS as readonly string[]).includes(params.method ?? "")
    ? (params.method as Method)
    : null;
  // Bucket is validated against what actually exists in the DB downstream, so
  // we accept the value here and let the filter no-op if nothing matches.
  const bucket =
    params.bucket && params.bucket.length > 0 && params.bucket !== "all" ? params.bucket : null;
  const status = (ALL_STATUSES as readonly string[]).includes(params.status ?? "")
    ? (params.status as StatusFilter)
    : null;
  // Snap to the canonical window allowlist (lib/windows.ts) — same contract
  // as every other surface. Rejecting arbitrary hour counts also bounds the
  // scan: the max option (720h) equals data retention.
  const windowHours = Number.parseInt(params.window ?? "1", 10);
  const window = WINDOW_VALUES.has(windowHours) ? windowHours : 1;
  // Cap target search to avoid pathological inputs in the ILIKE.
  const target = (params.target ?? "").slice(0, MAX_TARGET_LEN).trim();
  // Cap deep pagination at 10 pages. OFFSET is expensive in this query — the
  // per-row LATERAL sample-count join runs for every skipped row (measured
  // ~15ms/row live: OFFSET 2000 ≈ 30s) — so the cap is deliberately tight.
  // Replacing OFFSET with keyset pagination (cursor on generated_at) would
  // lift the limit cheaply if deeper browsing is ever needed.
  const offset = Math.min(500, Math.max(0, Number.parseInt(params.offset ?? "0", 10) || 0));
  return { method, bucket, status, window, target, offset };
}
