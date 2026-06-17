"use client";

/**
 * Share control for the leaderboard. Opens a centered modal (portaled to
 * <body>, with a scale/fade animation) showing a live preview of the card that
 * will be shared, plus three actions (all requested):
 *   - Tweet      → opens the X/Twitter compose intent linking to the host page
 *     with the current filters+weights encoded; that page's twitter:image meta
 *     points back at /og/leaderboard so the card renders in-feed.
 *   - Download   → fetches the /og/leaderboard PNG directly and saves it.
 *   - Copy       → copies the PNG to the clipboard (when supported).
 *
 * A centered modal (not an anchored popover) so it never clips off-screen near
 * the viewport edge. Filters — incl. the live scoring weights — come in as props
 * so the generated card matches exactly what the user is looking at. URL
 * building is shared with the route + metadata via lib/share.ts.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { buildShareParams, type ShareFilters } from "@/lib/share";

export function ShareButton({
  filters,
  /** Host page path whose card link gets tweeted (e.g. "/" or "/performance"). */
  pagePath,
}: {
  filters: ShareFilters;
  pagePath: string;
}) {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState(false); // drives the enter/exit transition
  const [status, setStatus] = useState<null | "working" | "copied" | "error">(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  const params = buildShareParams(filters).toString();
  const ogPath = `/og/leaderboard${params ? `?${params}` : ""}`;
  // A single method names itself; a blend uses the preset label.
  const shareLabel = filters.methods.length === 1 ? filters.methods[0]! : filters.presetId;
  const fileName = `rpc-benchmark-${shareLabel}-${filters.windowHours}h.png`;

  // Enter animation: mount, then flip `show` on the next frame so the transition
  // has a start state. Exit: clear `show`, unmount after the transition.
  useEffect(() => {
    if (!open) return;
    setPreviewLoaded(false);
    setStatus(null);
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  function close() {
    setShow(false);
    setTimeout(() => setOpen(false), 180);
  }

  // Lock body scroll + close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function shareUrl(): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}${pagePath}${params ? `?${params}` : ""}`;
  }

  function onTweet() {
    const text = `Live Solana RPC benchmark — ${shareLabel} ranked. Continuous, regional, non-gameable:`;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl())}`;
    window.open(intent, "_blank", "noopener,noreferrer");
    close();
  }

  async function onDownload() {
    try {
      setStatus("working");
      const res = await fetch(ogPath);
      if (!res.ok) throw new Error(`og ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(null);
    } catch {
      setStatus("error");
    }
  }

  async function onCopy() {
    try {
      setStatus("working");
      const res = await fetch(ogPath);
      if (!res.ok) throw new Error(`og ${res.status}`);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setStatus("copied");
      setTimeout(() => setStatus(null), 1500);
    } catch {
      setStatus("error");
    }
  }

  const canCopy =
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    "clipboard" in navigator &&
    typeof ClipboardItem !== "undefined";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-line2 px-3.5 py-[7px] text-[12px] font-medium text-fg2 transition-colors hover:text-fg hover:border-fg2 cursor-pointer"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Share
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
              onClick={close}
              aria-hidden="true"
              className={
                "absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-200 " +
                (show ? "opacity-100" : "opacity-0")
              }
            />

            {/* Panel */}
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Share leaderboard"
              className={
                "relative w-full max-w-[460px] overflow-hidden rounded-2xl border border-line2 bg-bg shadow-2xl transition-all duration-200 ease-out " +
                (show ? "opacity-100 scale-100" : "opacity-0 scale-95")
              }
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
                <span className="font-geistmono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Share leaderboard
                </span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="inline-flex items-center justify-center text-fg2 hover:text-fg cursor-pointer"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Live preview of the card that will be shared. */}
              <div className="relative m-5 overflow-hidden rounded-xl border border-line2 bg-surface">
                <div className="aspect-[1200/630] w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={ogPath}
                    alt="Share card preview"
                    className={
                      "h-full w-full object-contain transition-opacity duration-300 " +
                      (previewLoaded ? "opacity-100" : "opacity-0")
                    }
                    onLoad={() => setPreviewLoaded(true)}
                    onError={() => setStatus("error")}
                  />
                </div>
                {!previewLoaded && status !== "error" && (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted">
                    Generating preview…
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 px-5 pb-5">
                <button
                  type="button"
                  onClick={onTweet}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-accent px-4 py-2.5 text-[13px] font-medium text-accentfg transition-colors hover:bg-accent/90 cursor-pointer"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  Tweet
                </button>
                <button
                  type="button"
                  onClick={onDownload}
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-line2 px-4 py-2.5 text-[13px] font-medium text-fg2 transition-colors hover:text-fg hover:border-fg2 cursor-pointer"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {status === "working" ? "…" : "Download"}
                </button>
                {canCopy && (
                  <button
                    type="button"
                    onClick={onCopy}
                    aria-label="Copy image to clipboard"
                    className="inline-flex items-center justify-center rounded-full border border-line2 px-3.5 py-2.5 text-[13px] font-medium text-fg2 transition-colors hover:text-fg hover:border-fg2 cursor-pointer"
                  >
                    {status === "copied" ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    )}
                  </button>
                )}
              </div>

              {status === "error" && (
                <div className="px-5 pb-5 -mt-2 text-[12px]" style={{ color: "#ff6b6b" }}>
                  Couldn’t generate the image. Please try again.
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
