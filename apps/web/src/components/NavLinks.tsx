"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isActive } from "./navItems";

/**
 * Desktop top-nav links with an active state. Hidden on mobile (≤640px), where
 * the hamburger drawer (MobileMenu) takes over. See navItems.ts for the model.
 *
 * Status is omitted here: the desktop header already has the HeaderStatus
 * pill. The mobile drawer keeps it (the pill is hidden ≤640px).
 */
export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav-links">
      {NAV_ITEMS.filter((item) => item.href !== "/status").map((item) => {
        const active = isActive(item.href, pathname);
        return (
          <Link
            key={item.href}
            href={item.href as Route}
            className={active ? "is-active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
