"use client";

/**
 * Export control — an icon button that opens a small dropdown with CSV / JSON
 * download options. Data is built lazily (on click) via the supplied callbacks.
 */

import { useEffect, useRef, useState } from "react";
import { triggerDownload } from "@/lib/exportData";

export function ExportButtons({
  filename,
  buildCsv,
  buildJson,
}: {
  /** Base name without extension, e.g. "rpc-leaderboard". */
  filename: string;
  buildCsv: () => string;
  buildJson: () => unknown;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        </div>
      )}
    </div>
  );
}
