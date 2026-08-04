"use client";

/**
 * Export control — an icon button that opens a small dropdown with CSV / JSON
 * download options. Data is built lazily (on click) via the supplied callbacks.
 *
 * Optionally also offers "Embed URL" / "Embed iframe" items that copy a link to
 * the matching /embed/* widget, pre-filled with the caller's current filters —
 * so the view on screen is one click away from being embeddable elsewhere.
 */

import { useEffect, useRef, useState } from "react";
import { triggerDownload } from "@/lib/exportData";
import {
  buildEmbedUrl,
  clientEmbedOrigin,
  embedIframeSnippet,
  type EmbedWidget,
} from "@/lib/embedUrl";

/** Label for one embed item: idle text, or its own transient copy feedback. */
function embedLabel(
  copied: { kind: "url" | "iframe"; ok: boolean } | null,
  kind: "url" | "iframe",
  idle: string,
): string {
  if (copied?.kind !== kind) return idle;
  return copied.ok ? "Copied ✓" : "Copy failed";
}

/** Describes the /embed/* widget that mirrors this export's current view. */
export interface EmbedTarget {
  widget: EmbedWidget;
  /** Current filters as embed-route params; empty values are dropped. */
  params: Record<string, string | undefined>;
  /** Human title for the iframe's `title` attribute. */
  title: string;
}

export function ExportButtons({
  filename,
  buildCsv,
  buildJson,
  embed,
}: {
  /** Base name without extension, e.g. "rpc-leaderboard". */
  filename: string;
  buildCsv: () => string;
  buildJson: () => unknown;
  /** Omitted = no embed items, menu is CSV/JSON only (the default). */
  embed?: EmbedTarget | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Transient label swap on the embed items: which one was clicked, and whether
  // the copy succeeded. Null = idle. Tracking the kind keeps the feedback on the
  // clicked item only.
  const [copied, setCopied] = useState<{ kind: "url" | "iframe"; ok: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const download = (kind: "csv" | "json") => {
    if (kind === "csv") {
      triggerDownload(`${filename}.csv`, buildCsv(), "text/csv;charset=utf-8");
    } else {
      triggerDownload(`${filename}.json`, JSON.stringify(buildJson(), null, 2), "application/json");
    }
    setOpen(false);
  };

  // Copy an embed string. The origin is resolved HERE (in the handler) rather
  // than during render — `window` is guaranteed and nothing is hydrating, so the
  // link always matches the origin the user is actually on. writeText rejects on
  // a non-secure origin (plain-http LAN dev), hence the catch.
  const copyEmbed = async (kind: "url" | "iframe") => {
    if (!embed) return;
    const url = buildEmbedUrl(clientEmbedOrigin(), embed.widget, embed.params);
    const text = kind === "url" ? url : embedIframeSnippet(url, embed.title);
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ kind, ok: true });
    } catch {
      setCopied({ kind, ok: false });
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(null);
      setOpen(false);
    }, 1200);
  };

  const item =
    "block w-full text-left px-3 py-1.5 text-[12px] font-geistmono text-fg2 hover:text-fg hover:bg-fg/[0.05] transition-colors cursor-pointer";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label="Export data"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-bg border border-line text-fg2 hover:text-fg hover:border-line2 transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
          <path
            d="M12 15V4M12 4 8.5 7.5M12 4l3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 13v4.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V13"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 min-w-[110px] rounded-lg border border-line bg-surface py-1 shadow-xl shadow-black/40"
        >
          <button role="menuitem" type="button" className={item} onClick={() => download("csv")}>
            CSV
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => download("json")}>
            JSON
          </button>
          {embed && (
            <>
              <div className="my-1 border-t border-line" role="separator" />
              <button
                role="menuitem"
                type="button"
                className={item}
                onClick={() => void copyEmbed("url")}
              >
                {embedLabel(copied, "url", "Embed URL")}
              </button>
              <button
                role="menuitem"
                type="button"
                className={item}
                onClick={() => void copyEmbed("iframe")}
              >
                {embedLabel(copied, "iframe", "Embed iframe")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
