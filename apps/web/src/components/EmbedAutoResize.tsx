"use client";

import { useEffect } from "react";

/**
 * Keeps the host <iframe> sized to the embed content — it grows AND shrinks as
 * content changes (filter panel opens/closes, leaderboard row expands).
 *
 * No-delay path (same-origin hosts, e.g. helius.dev): the widget resizes its own
 * iframe element DIRECTLY via `window.frameElement`, synchronously inside the
 * ResizeObserver callback (before paint). There's no postMessage round-trip, so
 * the frame never lags the content — expanding a filter can't briefly clip it.
 *
 * Fallback path (cross-origin hosts): `window.frameElement` throws, so we
 * postMessage the height and the host sets it (one-tick lag). Host snippet:
 *   <iframe id="rpcbench" src=".../benchmarks/embed/chart?providers=helius,alchemy"
 *           style="width:100%;border:0" scrolling="no"></iframe>
 *   <script>
 *     addEventListener("message", (e) => {
 *       if (e.data?.type === "rpcbench-embed-size" && typeof e.data.height === "number")
 *         document.getElementById("rpcbench").style.height = e.data.height + "px";
 *     });
 *   </script>
 *
 * Why measure a specific element (not documentElement.scrollHeight): once the
 * iframe is set tall, documentElement.scrollHeight returns that tall viewport and
 * can only grow. The content root's own box height (`#rpcbench-embed-root`) is
 * intrinsic to the content, so it shrinks correctly too. The Method dropdown is
 * portaled to <body> (outside the root) so an open overlay doesn't inflate it.
 */
export default function EmbedAutoResize() {
  useEffect(() => {
    if (window.parent === window) return; // not framed — nothing to report

    const el = document.getElementById("rpcbench-embed-root") ?? document.body;

    // Resolve the same-origin iframe element ONCE. Accessing frameElement on a
    // cross-origin embed throws → null → we use postMessage instead.
    let frame: HTMLElement | null = null;
    try {
      frame = window.frameElement as HTMLElement | null;
    } catch {
      frame = null;
    }

    let last = -1;
    const post = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return; // coalesce identical updates
      last = height;
      if (frame) {
        // Synchronous, no round-trip: the frame tracks the content in the same
        // frame the ResizeObserver fired, so nothing is ever clipped mid-resize.
        frame.style.height = height + "px";
      } else {
        window.parent.postMessage({ type: "rpcbench-embed-size", height }, "*");
      }
    };

    post();

    const ro = new ResizeObserver(() => post());
    ro.observe(el);

    // Late async content (fonts, lazy chart data) + settle after any collapse.
    window.addEventListener("load", post);
    const t = setTimeout(post, 500);

    return () => {
      ro.disconnect();
      window.removeEventListener("load", post);
      clearTimeout(t);
    };
  }, []);

  return null;
}
