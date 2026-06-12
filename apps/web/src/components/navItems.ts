/**
 * Shared nav model used by both the desktop top-nav (NavLinks) and the mobile
 * hamburger drawer (MobileMenu), so the two stay in sync.
 *
 * The home/Overview route ("/") is also reachable via provider deep-dive routes
 * (`/provider/...`) that conceptually live under it, so it stays active for
 * those too; the other items match on prefix so nested routes keep their parent
 * highlighted.
 */
export const NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Overview" },
  { href: "/performance", label: "Performance" },
  { href: "/challenges", label: "Challenges" },
  { href: "/status", label: "Status" },
  { href: "/methodology", label: "Methodology" },
  { href: "/changelog", label: "Changelog" },
];

export function isActive(href: string, pathname: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname.startsWith("/provider");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
