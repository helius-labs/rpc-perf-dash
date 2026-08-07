/**
 * Tiny label helpers for the sends UI. Kept in their own leaf module (NOT in
 * lib/sends.ts) so client components can import them without pulling the server
 * data layer — which imports the `@rpcbench/shared` barrel → `canonical.ts` →
 * `node:crypto` — into the browser bundle. The `@rpcbench/shared/providers`
 * subpath below imports only types, so it stays client-safe.
 */

import { PROVIDERS } from "@rpcbench/shared/providers";

/** Human label for a scenario id: `orca_swap` → "Orca Swap", `transfer` → "Transfer". */
export function scenarioLabel(id: string): string {
  return id
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Human label for a send-target / provider id: the registry name, else the
 *  title-cased id (`cloudflare-staked` → "Cloudflare Staked"). The single source
 *  for what were five copies (SendsLeaderboard, SendTxnsTable, LatencyChart,
 *  og/sends, performance page). */
export function targetLabel(id: string): string {
  const p = PROVIDERS.find((row) => row.id === id);
  if (p) return p.name;
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
