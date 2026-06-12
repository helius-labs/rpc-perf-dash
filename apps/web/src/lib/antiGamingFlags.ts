/**
 * Human-readable explanations for `anti_gaming_flags` values defined on
 * benchmarked providers in `packages/shared/src/providers.ts`. The flag IDs
 * are short snake_case slugs intended for machine matching; this map turns
 * them into plain-English tooltips for the leaderboard caveat badge.
 *
 * Keep entries here in sync with the flag values used in providers.ts.
 */

export const ANTI_GAMING_FLAG_EXPLANATIONS: Record<string, string> = {
  non_rotatable_key:
    "This provider's URL embeds the key, so rotation requires endpoint reissue. Anti-gaming on this leaderboard does not rely on key rotation; the primary defense is randomized queries with on-chain-derived parameters and a 5-min TTL. See methodology § Anti-gaming defenses.",
};

export function explainAntiGamingFlags(flags: readonly string[]): string {
  if (flags.length === 0) return "";
  return flags
    .map((f) => `${f}: ${ANTI_GAMING_FLAG_EXPLANATIONS[f] ?? "(undocumented flag)"}`)
    .join("\n\n");
}
