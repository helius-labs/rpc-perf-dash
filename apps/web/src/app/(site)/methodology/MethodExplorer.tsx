"use client";

/**
 * Method Explorer — master/detail view of how every benchmarked RPC method's
 * challenge input is generated and how its correctness is verified.
 *
 * Left rail: methods grouped by their verification *technique* (byte-equal /
 * Jaccard / slot-tolerance / hybrid) so the question "which methods use Jaccard
 * vs tolerance vs an exact hash?" is answerable at a glance. Right pane: the
 * full per-method spec, split into INPUT (how the challenge is built) and
 * VERIFICATION (how correctness is decided).
 *
 * Client component: it owns the selected-method state, mirrors it to the URL
 * hash (#m-<method> deep-links), and supports ↑/↓ keyboard nav across the
 * flattened list. Data is plain, code-derived facts from methods.data.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopover } from "@/lib/usePopover";
import {
  METHODS,
  TECHNIQUES,
  type MethodSpec,
  type TechniqueKey,
} from "./methods.data";

// Trigger styling mirrored from the app's method-selector dropdowns
// (MethodSelectPill / MethodRegionTabs TRIGGER_CLS) so the mobile picker reads
// as the same control — an outline pill with a ▾ affordance.
const TRIGGER_CLS =
  "inline-flex items-center gap-1.5 px-[11px] py-[6px] text-[12px] rounded-full " +
  "font-geistmono tracking-[0.01em] cursor-pointer transition-colors " +
  "bg-bg border border-line text-fg2 hover:text-fg";

const TECHNIQUE_ORDER: TechniqueKey[] = [
  "byte-equal",
  "jaccard",
  "tolerance",
  "value-tolerance",
  "well-formed",
  "hybrid",
];

interface Group {
  key: TechniqueKey;
  methods: MethodSpec[];
}

function buildGroups(): { live: Group[]; dormant: MethodSpec[] } {
  const live: Group[] = [];
  for (const key of TECHNIQUE_ORDER) {
    const methods = METHODS.filter((m) => m.technique === key && !m.dormant);
    if (methods.length) live.push({ key, methods });
  }
  const dormant = METHODS.filter((m) => m.dormant);
  return { live, dormant };
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] min-[760px]:grid-cols-[96px_minmax(0,1fr)] gap-2.5 min-[760px]:gap-3.5 py-[5px]">
      <span className="font-geistmono text-[11px] text-muted pt-px">{k}</span>
      <span className="text-[13px] leading-[1.5] text-fg2">{v}</span>
    </div>
  );
}

/**
 * Mobile method picker — a single-select port of the app's method-selector
 * dropdown (MethodSelectPill): the same pill trigger + portaled, viewport-
 * clamped popover, but one choice at a time (no checkboxes, no "All methods"
 * row). Grouped by verification technique to mirror the desktop rail.
 */
function MethodDropdown({
  live,
  dormant,
  activeName,
  onSelect,
}: {
  live: Group[];
  dormant: MethodSpec[];
  activeName: string;
  onSelect: (name: string) => void;
}) {
  const { open, setOpen, triggerRef, panelRef, panelStyle } = usePopover();

  function row(m: MethodSpec) {
    const isActive = m.name === activeName;
    return (
      <button
        key={m.name}
        type="button"
        role="option"
        aria-selected={isActive}
        onClick={() => {
          onSelect(m.name);
          setOpen(false);
        }}
        className={
          "flex w-full items-center text-left rounded px-2.5 py-[6px] text-[12px] " +
          "font-geistmono tracking-[0.01em] cursor-pointer transition-colors hover:bg-line/40 " +
          (m.dormant ? "italic " : "") +
          (isActive ? "text-fg font-medium" : (m.dormant ? "text-muted" : "text-fg2") + " hover:text-fg")
        }
      >
        <span className="truncate">{m.name}</span>
      </button>
    );
  }

  function groupHeader(label: string, color: string) {
    return (
      <div className="flex items-center gap-[7px] px-2.5 pt-1.5 pb-1">
        <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: color }} />
        <span className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-muted">
          {label}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={TRIGGER_CLS + " w-full justify-between"}
      >
        <span className="truncate">{activeName}</span>
        <span aria-hidden className="text-[9px] opacity-70 shrink-0">
          ▾
        </span>
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            style={panelStyle}
            className="min-w-[220px] p-1.5 rounded-md border border-line bg-bg shadow-lg max-h-[400px] overflow-y-auto"
          >
            {live.map((g) => (
              <div key={g.key} className="mb-0.5">
                {groupHeader(TECHNIQUES[g.key].label, TECHNIQUES[g.key].color)}
                {g.methods.map(row)}
              </div>
            ))}
            {dormant.length > 0 && (
              <div>
                {groupHeader("Dormant", "var(--muted)")}
                {dormant.map(row)}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default function MethodExplorer() {
  const { live, dormant } = useMemo(buildGroups, []);
  // Flattened order for keyboard nav + default selection.
  const flat = useMemo(
    () => [...live.flatMap((g) => g.methods), ...dormant],
    [live, dormant],
  );
  const [selected, setSelected] = useState<string>(flat[0]?.name ?? "");
  const navRef = useRef<HTMLDivElement>(null);

  // Deep-link: read #m-<name> on mount.
  useEffect(() => {
    const hash = window.location.hash;
    const match = /^#m-([A-Za-z]+)$/.exec(hash);
    if (match && flat.some((m) => m.name === match[1])) setSelected(match[1]!);
  }, [flat]);

  const select = useCallback((name: string) => {
    setSelected(name);
    // Replace (not push) so the explorer doesn't flood browser history.
    history.replaceState(null, "", `#m-${name}`);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const idx = flat.findIndex((m) => m.name === selected);
      const next =
        e.key === "ArrowDown"
          ? Math.min(flat.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const name = flat[next]?.name;
      if (name) {
        select(name);
        navRef.current
          ?.querySelector<HTMLButtonElement>(`[data-method="${name}"]`)
          ?.focus();
      }
    },
    [flat, selected, select],
  );

  const active = flat.find((m) => m.name === selected) ?? flat[0];
  if (!active) return null;
  const activeName = active.name;
  const tech = TECHNIQUES[active.technique];

  const itemBase =
    "mx-item text-left bg-transparent border-0 border-l-2 cursor-pointer py-[5px] pr-2 pl-3.5 " +
    "rounded-r-[5px] font-geistmono text-[12.5px] transition-colors " +
    "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

  function itemClass(m: MethodSpec): string {
    const isActive = m.name === activeName;
    const dormantTone = m.dormant ? "italic " : "";
    if (isActive) {
      return (
        itemBase +
        " " +
        dormantTone +
        "text-fg border-l-[var(--tech)] bg-[color-mix(in_oklch,var(--tech)_14%,transparent)]"
      );
    }
    return (
      itemBase +
      " border-transparent " +
      dormantTone +
      (m.dormant ? "text-muted" : "text-fg2") +
      " hover:text-fg hover:bg-[color-mix(in_oklch,var(--text)_4%,transparent)]"
    );
  }

  return (
    <div
      className={
        "grid grid-cols-[minmax(0,1fr)] min-[760px]:grid-cols-[216px_minmax(0,1fr)] " +
        "gap-[18px] min-[760px]:gap-[26px] my-6 border border-line rounded-[10px] " +
        "bg-surface p-4 min-[760px]:px-6 min-[760px]:py-5"
      }
      role="group"
      aria-label="Per-method inputs and verification"
    >
      {/* Mobile: single-select method dropdown (the grouped rail is desktop-only). */}
      <div className="min-[760px]:hidden">
        <MethodDropdown live={live} dormant={dormant} activeName={activeName} onSelect={select} />
      </div>

      <div
        className={
          "hidden min-[760px]:flex flex-col gap-4 min-[760px]:border-r min-[760px]:border-line " +
          "min-[760px]:pr-[22px] min-[760px]:max-h-[480px] min-[760px]:overflow-y-auto"
        }
        ref={navRef}
        onKeyDown={onKeyDown}
      >
        {live.map((g) => {
          const t = TECHNIQUES[g.key];
          return (
            <div className="flex flex-col gap-0.5" key={g.key} style={{ ["--tech" as string]: t.color }}>
              <div className="flex items-center gap-[7px] pb-1.5">
                <span className="w-[7px] h-[7px] rounded-full shrink-0 bg-[var(--tech)]" />
                <span className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-fg2">
                  {t.label}
                </span>
                <span className="ml-auto font-geistmono text-[10px] text-muted">{g.methods.length}</span>
              </div>
              {g.methods.map((m) => (
                <button
                  key={m.name}
                  type="button"
                  data-method={m.name}
                  title={m.name}
                  className={itemClass(m)}
                  aria-pressed={m.name === active.name}
                  onClick={() => select(m.name)}
                >
                  <span className="mx-name">{m.name}</span>
                </button>
              ))}
            </div>
          );
        })}
        {dormant.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-[7px] pb-1.5">
              <span className="w-[7px] h-[7px] rounded-full shrink-0 bg-muted" />
              <span className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-fg2">
                Dormant
              </span>
              <span className="ml-auto font-geistmono text-[10px] text-muted">{dormant.length}</span>
            </div>
            {dormant.map((m) => (
              <button
                key={m.name}
                type="button"
                data-method={m.name}
                title={m.name}
                className={itemClass(m)}
                aria-pressed={m.name === active.name}
                onClick={() => select(m.name)}
              >
                <span className="mx-name">{m.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-w-0" style={{ ["--tech" as string]: tech.color }}>
        <div className="flex items-center gap-3 flex-wrap">
          <h4 className="m-0 font-geistmono text-[18px] font-semibold tracking-[-0.01em] text-fg">
            {active.name}
          </h4>
          <span
            className={
              "inline-flex items-center px-[9px] py-[3px] rounded-full font-geistmono text-[11px] " +
              (active.dormant
                ? "text-muted border border-line2 bg-surface2"
                : "text-[var(--tech)] border border-[color-mix(in_oklch,var(--tech)_40%,transparent)] bg-[color-mix(in_oklch,var(--tech)_12%,transparent)]")
            }
          >
            {active.techniqueDetail}
          </span>
        </div>
        <p className="mt-2 mb-0 text-[13px] text-muted">{active.shape}</p>

        {active.dormant && (
          <div className="mt-3.5 px-3 py-2 border border-line2 rounded-md bg-surface2 text-[12.5px] text-fg2">
            Implemented but <strong className="text-fg font-semibold">not emitted</strong> by the generator.
          </div>
        )}

        <section className="mt-[18px]">
          <div className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-muted pb-2 mb-2 border-b border-line">
            Input · how the challenge is generated
          </div>
          <Field k="Draws" v={active.input.draws} />
          <Field k="From" v={active.input.from} />
          <Field k="Buckets" v={active.input.buckets} />
          {active.input.commitment && <Field k="Commitment" v={active.input.commitment} />}
          {active.input.perturbation && <Field k="Perturbation" v={active.input.perturbation} />}
        </section>

        <section className="mt-[18px]">
          <div className="font-geistmono text-[10px] tracking-[0.12em] uppercase text-muted pb-2 mb-2 border-b border-line">
            Verification · how correctness is decided
          </div>
          <Field k="Projects" v={active.projection.keeps} />
          <Field k="Drops" v={active.projection.drops} />
          <Field k="Match" v={active.match} />
          <Field k="Voters" v={active.voters} />
        </section>

        {active.notes && active.notes.length > 0 && (
          <ul className="list-none mt-4 mb-0 p-0 flex flex-col gap-2">
            {active.notes.map((n, i) => (
              <li
                key={i}
                className={
                  "relative m-0 py-2 pr-3 pl-7 rounded-md text-[12.5px] leading-[1.45] text-fg2 " +
                  "bg-[color-mix(in_oklch,var(--accent)_7%,transparent)] " +
                  "border border-[color-mix(in_oklch,var(--accent)_22%,transparent)] " +
                  "before:content-['!'] before:absolute before:left-[11px] before:top-2 " +
                  "before:font-geistmono before:text-[11px] before:font-bold before:text-accent"
                }
              >
                {n}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
