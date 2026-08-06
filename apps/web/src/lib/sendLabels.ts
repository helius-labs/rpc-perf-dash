/**
 * Tiny, dependency-free label helpers for the sends UI. Kept in their own leaf
 * module (NOT in lib/sends.ts) so client components can import them without
 * pulling the server data layer — which imports `@rpcbench/shared` →
 * `canonical.ts` → `node:crypto` — into the browser bundle.
 */

/** Human label for a scenario id: `orca_swap` → "Orca Swap", `transfer` → "Transfer". */
export function scenarioLabel(id: string): string {
  return id
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
