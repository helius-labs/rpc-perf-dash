/**
 * Shared nav model used by both the desktop top-nav (NavLinks) and the mobile
 * hamburger drawer (MobileMenu), so the two stay in sync.
 *
 * Items are either a plain link or a dropdown group with children. The
 * Leaderboard and Performance items are groups that switch between the RPC read
 * board and the transaction-Sends board.
 */

export interface NavLink {
  href: string;
  label: string;
}
export interface NavGroup {
  label: string;
  children: NavLink[];
}
export type NavItem = NavLink | NavGroup;

export function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  {
    label: "Leaderboard",
    children: [
      { href: "/", label: "RPCs" },
      { href: "/sends", label: "Sends" },
    ],
  },
  {
    label: "Performance",
    children: [
      { href: "/performance", label: "RPCs" },
      { href: "/performance?board=sends", label: "Sends" },
    ],
  },
  { href: "/challenges", label: "Challenges" },
  { href: "/status", label: "Status" },
  { href: "/methodology", label: "Methodology" },
  { href: "/changelog", label: "Changelog" },
];

/** Active-state matcher for a single link's href. */
export function isActive(href: string, pathname: string): boolean {
  // Strip any query string (the Sends performance link carries ?board=sends;
  // pathname never includes it, so match on the path).
  const path = href.split("?")[0]!;
  if (path === "/") {
    return pathname === "/" || pathname.startsWith("/provider");
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** A group is active when any of its children is active for the current path. */
export function isGroupActive(group: NavGroup, pathname: string): boolean {
  return group.children.some((c) => isActive(c.href, pathname));
}
