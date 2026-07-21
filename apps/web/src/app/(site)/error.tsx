"use client";

import { useEffect } from "react";

/**
 * Route-segment error boundary for the whole app. Next.js renders this client
 * component whenever a server (or client) render throws an unhandled error in
 * any page under `app/` — including errors surfaced from inside a <Suspense>
 * boundary while streaming. Without it, an unhandled throw (e.g. the DB OOMing
 * on a heavy query) shows the bare "Application error: a server-side exception
 * has occurred" screen with only a digest. This degrades that to a readable
 * message plus a retry, and keeps the chrome (header/nav from the layout)
 * since error.tsx renders inside the layout.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaces to the browser console (and any client error reporting); the
    // server-side cause is already logged where it was thrown.
    console.error(error);
  }, [error]);

  return (
    <div className="py-16 max-w-[560px]">
      <h1 className="text-[26px] font-semibold tracking-[-0.022em] text-fg mt-0 mb-3">
        Something went wrong
      </h1>
      <p className="text-[14.5px] leading-[1.6] text-fg2 mb-5">
        This page hit a temporary error while loading. This is usually transient
        — try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center rounded-full border border-line px-4 py-2 text-[13px] font-geistmono tracking-[0.01em] text-fg hover:bg-surface"
      >
        Try again
      </button>
      {error.digest && (
        <p className="mt-5 text-[12px] font-geistmono text-muted">
          Reference: {error.digest}
        </p>
      )}
    </div>
  );
}
