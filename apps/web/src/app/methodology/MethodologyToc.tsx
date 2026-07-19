"use client";

/**
 * Sticky table-of-contents rail for the methodology page, with scroll-spy.
 *
 * Entries (slug + title) are derived server-side from the doc's `##` headings
 * and passed in as plain data. An IntersectionObserver tracks which section is
 * in view and highlights the matching link. Hidden below the wide breakpoint
 * (the page CSS drops the TOC column there) — it's a desktop reading aid.
 */

import { useEffect, useState } from "react";

export interface TocEntry {
  slug: string;
  title: string;
}

export default function MethodologyToc({ entries }: { entries: readonly TocEntry[] }) {
  const [activeSlug, setActiveSlug] = useState<string>(entries[0]?.slug ?? "");

  useEffect(() => {
    const targets = entries
      .map((e) => document.getElementById(e.slug))
      .filter((el): el is HTMLElement => el != null);
    if (!targets.length) return;

    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.isIntersecting) visible.set(r.target.id, r.intersectionRatio);
          else visible.delete(r.target.id);
        }
        // Highlight the topmost section currently in view.
        let best: string | null = null;
        for (const e of entries) {
          if (visible.has(e.slug)) {
            best = e.slug;
            break;
          }
        }
        if (best) setActiveSlug(best);
      },
      // Bias the "active" band toward the upper third of the viewport.
      { rootMargin: "-10% 0px -70% 0px", threshold: [0, 1] },
    );
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [entries]);

  return (
    <nav className="sticky top-6" aria-label="On this page">
      <div className="font-geistmono text-[10px] tracking-[0.14em] uppercase text-muted mb-3">
        On this page
      </div>
      <ul className="list-none m-0 p-0 flex flex-col border-l border-line">
        {entries.map((e) => {
          const active = e.slug === activeSlug;
          return (
            <li key={e.slug}>
              <a
                href={`#${e.slug}`}
                className={
                  "block py-1.5 pl-3.5 -ml-px border-l text-[12.5px] leading-[1.35] " +
                  "transition-colors hover:no-underline " +
                  (active
                    ? "text-fg border-accent"
                    : "text-muted border-transparent hover:text-fg2")
                }
                aria-current={active ? "true" : undefined}
              >
                {e.title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
