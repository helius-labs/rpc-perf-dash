/**
 * Honeypot pool & selection.
 *
 * Honeypots are randomly sampled deeply-finalized history (slot range:
 * tip − 1000 epochs to tip − 10 epochs, drawn uniformly), then validated
 * against the 3-node quorum offline. Only candidates where all 3 agree
 * are stored as honeypots — guarantees expected_projection is reliable.
 *
 * Indistinguishability requirement: pool is sampled uniformly at random.
 * Operator must not pick "interesting" cases (genesis block, popular signatures,
 * etc.) because providers could route those to a guaranteed-correct path.
 *
 * is_honeypot is hidden from worker queries via the challenges_worker_view.
 * Workers cannot tell honeypots from regular challenges at execution time.
 */

import type { Method } from "./types.js";

export interface HoneypotEntry {
  id: string;
  method: Method;
  params: unknown;
  /** Canonicalized projection hash (hex) of the agreed-upon answer. */
  expected_projection_hash: string;
  expected_projection: unknown;
  methodology_version: number;
  /** ISO timestamp. Used for LRU draws. */
  last_used_at: string | null;
  use_count: number;
}

/** Target injection rate. Generator picks a honeypot vs a fresh challenge with this probability. */
export const HONEYPOT_INJECTION_RATE = 0.05;

/** Target pool size per method. */
export const HONEYPOT_POOL_TARGET_PER_METHOD = 2000;

/** Pool refresh cadence — operator-driven. */
export const HONEYPOT_POOL_REFRESH_DAYS = 30;
