/**
 * Shared nav model used by both the desktop top-nav (NavLinks) and the mobile
 * hamburger drawer (MobileMenu), so the two stay in sync.
 *
 * The home/Overview route ("/") is also reachable via provider deep-dive routes
 * (`/provider/...`) that conceptually live under it, so it stays active for
 * those too; the other items match on prefix so nested routes keep their parent
 * highlighted.
 */
import { isFeatureEnabled } from "@/lib/flags";

export const NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/performance", label: "Performance" },
  { href: "/challenges", label: "Challenges" },
  { href: "/status", label: "Status" },
  { href: "/methodology", label: "Methodology" },
  { href: "/changelog", label: "Changelog" },
  // Cost comparator — gated behind NEXT_PUBLIC_FEATURE_COSTS (see lib/flags.ts).
  // Appended last so it's a no-op for the existing tabs when the flag is off.
  ...(isFeatureEnabled("costs") ? [{ href: "/costs", label: "Costs" }] : []),
];

export function isActive(href: string, pathname: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname.startsWith("/provider");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
