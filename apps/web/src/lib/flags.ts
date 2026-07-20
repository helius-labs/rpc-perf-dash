/**
 * Feature flags for the web app.
 *
 * Flags are read from `NEXT_PUBLIC_*` env vars so the same value is available
 * in both server components (where we `notFound()` a disabled route) and client
 * components (where we hide nav entries). Next inlines `NEXT_PUBLIC_*` at build
 * time, so a flag only changes when the app is rebuilt/redeployed with a new
 * value — which is exactly what we want for a deliberate "flip the switch".
 *
 * Default (unset) = off. Enable locally via apps/web/.env.local:
 *   NEXT_PUBLIC_FEATURE_COSTS=1
 */

export type FeatureName = "costs";

const FLAG_ENV: Record<FeatureName, string | undefined> = {
  // Reference each var statically (not via dynamic key) so Next's build-time
  // inlining of NEXT_PUBLIC_* works.
  costs: process.env.NEXT_PUBLIC_FEATURE_COSTS,
};

export function isFeatureEnabled(name: FeatureName): boolean {
  return FLAG_ENV[name] === "1";
}
