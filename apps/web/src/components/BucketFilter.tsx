/**
 * Compact bucket filter for /challenges. Server component — the disclosure
 * is native <details>, the pills are <Link>s, neither needs client JS, and
 * `hrefFor` is called server-side at render. Marking this "use client" was
 * a mistake on first pass (broke serialization of the `hrefFor` prop).
 *
 * Buckets follow a `<family>__<variant>` pattern (`archival__low`,
 * `last_24h__high`, `large__simple__legacy__archival`...). A flat pill row
 * for 16+ getTransaction buckets is unreadable, so this groups buckets by
 * the first `__` segment and renders a native `<details>` disclosure widget:
 *
 *   [ Bucket: All ▾ ]   <- pill-styled summary, click to open
 *     ┌──────────────────────────────────────────┐
 *     │  archival      [all] [low] [high]        │
 *     │  last_hour     [all] [low] [high]        │
 *     │  last_24h      [all] [low] [high]        │
 *     │  tip_minus_5   [all] [low] [high]        │
 *     └──────────────────────────────────────────┘
 *
 * Selection semantics (server-side decoded in the page):
 *   ?bucket=archival           → matches archival__low + archival__high
 *                                (family without a __ → LIKE 'archival__%')
 *   ?bucket=archival__low      → exact match
 *   ?bucket  unset / "all"     → no bucket filter
 *
 * Native `<details>` is intentional — no client JS needed beyond the
 * useLinkStatus pill (existing `FilterPill`). The dropdown closes on the
 * next render after a navigation.
 */

import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

interface Props {
  /** Distinct bucket strings observed for the current (method, window). */
  options: readonly string[];
  /** Selected bucket — may be a full bucket id or a family-only prefix. */
  selected: string | null;
  /** Build href with the given bucket param (null = clear). */
  hrefFor: (bucket: string | null) => string;
}

interface Family {
  name: string;
  /** `null` if the family has no variants (e.g. getSlot's `processed`). */
  variants: string[];
}

function groupByFamily(options: readonly string[]): Family[] {
  const families = new Map<string, string[]>();
  for (const b of options) {
    const idx = b.indexOf("__");
    if (idx === -1) {
      // Bucket has no family separator — treat the whole name as both the
      // family name and a self-contained option (e.g. `processed`).
      if (!families.has(b)) families.set(b, []);
      continue;
    }
    const family = b.slice(0, idx);
    const variant = b.slice(idx + 2);
    if (!families.has(family)) families.set(family, []);
    families.get(family)!.push(variant);
  }
  return [...families.entries()]
    .map(([name, variants]) => ({ name, variants: variants.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summaryLabel(selected: string | null, options: readonly string[]): string {
  if (!selected) return "All";
  // Exact bucket id selected → render family/variant.
  if (selected.includes("__")) {
    const idx = selected.indexOf("__");
    return `${selected.slice(0, idx)} / ${selected.slice(idx + 2)}`;
  }
  // Family-only prefix — count how many buckets it covers in this view.
  const matches = options.filter(
    (b) => b === selected || b.startsWith(`${selected}__`),
  ).length;
  return matches > 1 ? `${selected} (all ${matches})` : selected;
}

const PILL_BASE =
  "inline-block px-[9px] py-[3px] rounded-full text-[11px] font-geistmono " +
  "tracking-[0.01em] transition-colors border border-transparent";
const PILL_ACTIVE = `${PILL_BASE} bg-fg text-bg`;
const PILL_INACTIVE = `${PILL_BASE} text-fg2 hover:text-fg hover:border-line`;

function Pill({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: ReactNode;
}) {
  return (
    <Link href={href as Route} className={active ? PILL_ACTIVE : PILL_INACTIVE}>
      {children}
    </Link>
  );
}

export function BucketFilter({ options, selected, hrefFor }: Props) {
  if (options.length === 0) {
    // No buckets observed in this window — render a disabled-looking
    // summary so the filter row stays the same height.
    return (
      <span className="text-[11px] text-fg2/60 font-geistmono">No buckets in window</span>
    );
  }
  const families = groupByFamily(options);
  const label = summaryLabel(selected, options);

  return (
    <details className="bucket-filter relative inline-block">
      <summary
        className={
          "list-none cursor-pointer select-none inline-flex items-center gap-1.5 " +
          "px-[11px] py-[5px] rounded-full text-[12px] font-geistmono " +
          "tracking-[0.01em] border " +
          (selected ? "bg-fg text-bg border-fg" : "bg-transparent text-fg2 border-line hover:text-fg")
        }
      >
        <span>{label}</span>
        <span aria-hidden className="text-[10px] opacity-70">▾</span>
      </summary>

      <div
        className={
          "absolute left-0 top-[calc(100%+6px)] z-20 min-w-[320px] max-w-[560px] " +
          "p-3 rounded-md border border-line bg-bg shadow-lg " +
          "max-h-[400px] overflow-y-auto"
        }
      >
        {/* "All" reset row */}
        <div className="mb-2 pb-2 border-b border-line">
          <Pill active={selected === null} href={hrefFor(null)}>
            All buckets
          </Pill>
        </div>

        {families.map((f) => {
          const familyOnlyHref = hrefFor(f.name);
          const familyActive = selected === f.name;
          // Hide family-level pill when the family has zero variants — the
          // single-bucket case (e.g. `processed`) is already rendered as a
          // standalone pill below.
          const hasVariants = f.variants.length > 0;
          return (
            <div
              key={f.name}
              className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 items-center py-1"
            >
              <div className="text-[11px] text-fg2 uppercase tracking-[0.06em]">
                {f.name}
              </div>
              <div className="flex flex-wrap gap-1">
                {hasVariants && (
                  <Pill active={familyActive} href={familyOnlyHref}>
                    all
                  </Pill>
                )}
                {hasVariants
                  ? f.variants.map((v) => {
                      const full = `${f.name}__${v}`;
                      return (
                        <Pill
                          key={v}
                          active={selected === full}
                          href={hrefFor(full)}
                        >
                          {v}
                        </Pill>
                      );
                    })
                  : (
                    <Pill active={selected === f.name} href={hrefFor(f.name)}>
                      {f.name}
                    </Pill>
                  )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
