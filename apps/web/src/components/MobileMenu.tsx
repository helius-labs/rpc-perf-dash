"use client";

/**
 * Mobile nav — a hamburger button that opens a slide-in sidebar drawer from the
 * right. Shown only ≤640px (the desktop NavLinks is hidden there). Closes on
 * link tap, backdrop click, or Escape; locks body scroll while open.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, isActive } from "./navItems";
import { FLEET_DOT } from "@/lib/fleetStatus";
import { useFleetStatus } from "./useFleetStatus";

export default function MobileMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const fleetStatus = useFleetStatus();

  // Close on route change so tapping a link doesn't leave the drawer open.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll + close on Escape while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="hidden max-[640px]:block">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        className="inline-flex items-center justify-center text-fg2 hover:text-fg"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>

      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden="true"
        className={
          "fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 " +
          (open ? "opacity-100" : "pointer-events-none opacity-0")
        }
      />

      {/* Sidebar drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={
          "fixed top-0 right-0 z-50 h-full w-[78%] max-w-[300px] bg-bg border-l border-line shadow-2xl flex flex-col transition-transform duration-200 ease-out " +
          (open ? "translate-x-0" : "translate-x-full")
        }
      >
        <div className="flex items-center justify-between px-5 py-[18px] border-b border-line">
          <span className="font-geistmono text-[12px] uppercase tracking-[0.14em] text-muted">Menu</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
            className="inline-flex items-center justify-center text-fg2 hover:text-fg"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="flex flex-col px-2 py-3">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href as Route}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={
                  "flex items-center justify-between px-3 py-3 rounded-md text-[15px] transition-colors " +
                  (active ? "text-fg bg-surface font-medium" : "text-fg2 hover:text-fg hover:bg-surface")
                }
              >
                {item.label}
                {/* The Status row carries the live fleet dot — the header pill
                    is hidden on mobile, so this is its stand-in. */}
                {item.href === "/status" && (
                  <span
                    className="inline-flex h-2 w-2 rounded-full"
                    aria-hidden="true"
                    style={{ background: fleetStatus ? FLEET_DOT[fleetStatus] : FLEET_DOT.absent }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto px-2 py-3 border-t border-line">
          <a
            href="https://github.com/helius-labs/rpc-perf-dash"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-3 rounded-md text-[15px] text-fg2 transition-colors hover:text-fg hover:bg-surface hover:no-underline"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-1.92c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.26 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
            </svg>
            GitHub
          </a>
        </div>
      </aside>
    </div>
  );
}
