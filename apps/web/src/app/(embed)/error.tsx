"use client";

import { useEffect } from "react";

// Compact error boundary for embeds — no site chrome, no big headings. A framed
// widget that throws shows a small inline message + retry instead of bubbling up
// to the site error UI.
export default function EmbedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="py-8 text-center">
      <p className="text-[13px] leading-[1.6] text-fg2 mb-3">
        This widget hit a temporary error. Usually transient — try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center rounded-full border border-line px-3 py-[6px] text-[12px] font-geistmono text-fg hover:bg-surface"
      >
        Try again
      </button>
    </div>
  );
}
