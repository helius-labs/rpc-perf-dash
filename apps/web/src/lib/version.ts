/**
 * Displayed app version. Sourced from apps/web/package.json at build time via
 * next.config.ts (NEXT_PUBLIC_APP_VERSION), so bumping the package version is
 * the only edit needed. The fallback only applies to non-Next contexts (e.g.
 * `tsc --noEmit`), never a real build.
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "1.0.0";
