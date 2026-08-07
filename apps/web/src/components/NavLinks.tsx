"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { Suspense, useEffect, useRef, useState } from "react";
import { NAV_ITEMS, isActive, isGroup, isGroupActive, type NavGroup } from "./navItems";

/**
 * Active-state for a dropdown child, distinguishing siblings that share a path
 * but differ by the `?board=` query (RPCs vs Sends performance). `board` is the
 * current URL's board param.
 */
function childActive(href: string, pathname: string, board: string | null): boolean {
  const [path, query] = href.split("?");
  if (!isActive(path!, pathname)) return false;
  const hrefBoard = query ? new URLSearchParams(query).get("board") : null;
  if (hrefBoard) return board === hrefBoard; // Sends child: needs board=sends
  return board === null || board === "rpcs"; // default (RPCs) child
}

/**
 * Desktop top-nav. Plain links plus dropdown groups (Leaderboard / Performance)
 * that switch between the RPC read board and the transaction-Sends board. Hidden
 * on mobile (≤640px), where the hamburger drawer (MobileMenu) takes over.
 *
 * Status is omitted here: the desktop header already has the HeaderStatus pill.
 */
export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="nav-links">
      {NAV_ITEMS.filter((item) => isGroup(item) || item.href !== "/status").map((item) => {
        if (isGroup(item))
          return (
            // NavDropdown reads useSearchParams(); the Suspense boundary lets the
            // otherwise-static pages (/sends, /changelog, /api-reference) keep
            // static rendering instead of bailing out. Fallback keeps the group
            // label linked in the SSR HTML. (The menu's position is fixed by the
            // portal in NavDropdown, independent of this boundary.)
            <Suspense
              key={item.label}
              fallback={
                <Link href={item.children[0]!.href as Route} className="nav-trigger">
                  {item.label}
                </Link>
              }
            >
              <NavDropdown group={item} pathname={pathname} />
            </Suspense>
          );
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

/** Hover/focus dropdown group — the label links to the default (RPCs) board and
 *  Click-to-open: the label toggles the menu; items navigate + close. Closes on
 *  outside-click or route change. */
function NavDropdown({ group, pathname }: { group: NavGroup; pathname: string }) {
  const active = isGroupActive(group, pathname);
  const board = useSearchParams().get("board");
  const defaultHref = group.children[0]!.href; // RPCs board — clicking the label goes here
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hover to open; a short close delay bridges the gap between trigger and menu.
  const openMenu = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left });
    }
    setOpen(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  useEffect(() => setOpen(false), [pathname]); // close after navigating
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <div ref={ref} className="inline-flex" onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      {/* Clicking the label navigates to the RPCs board; hovering opens the menu. */}
      <Link
        href={defaultHref as Route}
        className={`nav-trigger ${active ? "is-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {group.label}
        <svg
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" aria-hidden="true"
          className={`opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </Link>
      {/* Portaled to <body>: position:fixed at the trigger's viewport coords. The
          site header has backdrop-blur (backdrop-filter), which establishes a
          containing block for fixed descendants — rendered inline, the menu would
          be offset by the header's centered/padded box. The portal escapes that
          AND the .nav-links overflow clip. Hovering the menu keeps it open. */}
      {open && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            className="nav-drop-menu"
            style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 60 }}
            role="menu"
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
          >
            {group.children.map((c) => {
              const cActive = childActive(c.href, pathname, board);
              return (
                <Link
                  key={c.href}
                  href={c.href as Route}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  aria-current={cActive ? "page" : undefined}
                  className={cActive ? "is-active" : undefined}
                >
                  {c.label}
                </Link>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
