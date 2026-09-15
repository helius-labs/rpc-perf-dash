/**
 * Frozen copy of the send leaderboard, rendered by /embed/sends-snapshot.
 *
 * GENERATED — do not hand-edit. Run `pnpm snapshot:sends --write`, review the
 * diff, and land it as a PR. Hand-editing risks a date that doesn't match the
 * numbers, which is the one failure mode this whole file exists to prevent.
 *
 * The embed prints `asOf` next to the rows and links to the live board, so a
 * snapshot that stops being refreshed reads as visibly stale rather than as a
 * current claim.
 *
 * Ships EMPTY: the generator reads `window_end` off /api/sends, which only
 * exists once this branch is deployed. First run after deploy populates it; the
 * embed renders an explicit "not yet published" state until then rather than
 * standing up placeholder numbers.
 */

import type { SendsLeaderboardRow } from "@/components/SendsLeaderboard";

export interface SendsSnapshot {
  /** Data date (UTC, from the API's window_end) — NOT the generation date. */
  asOf: string;
  /** Rollup grain the rows were scored over. */
  grain: "1h" | "1d";
  rows: SendsLeaderboardRow[];
}

export const SENDS_SNAPSHOT: SendsSnapshot = {
  asOf: "",
  grain: "1d",
  rows: [],
};
